import crypto from "crypto";
import levelup from "levelup";
import sublevel from "sublevel-pouchdb";
import { obj as through } from "through2";
import Deque from "double-ended-queue";
//import bufferFrom from 'buffer-from'; // ponyfill for Node <6
import {
  clone,
  changesHandler as Changes,
  filterChange,
  functionName,
  uuid,
  nextTick,
  getArguments
} from "pouchdb-utils";
import {
  allDocsKeysQuery,
  isDeleted,
  isLocalId,
  parseDoc,
  processDocs
} from "pouchdb-adapter-utils";
import {
  winningRev as calculateWinningRev,
  traverseRevTree,
  compactTree,
  collectConflicts,
  latest as getLatest
} from "pouchdb-merge";
// import {
//   safeJsonParse,
//   safeJsonStringify
// } from 'pouchdb-json';

// import {
//   binaryMd5
// } from 'pouchdb-md5';

import {
  atob,
  binaryStringToBlobOrBuffer as binStringToBluffer
} from "pouchdb-binary-utils";

import readAsBluffer from "./readAsBlobOrBuffer";
import createEmptyBluffer from "./createEmptyBlobOrBuffer";

import LevelTransaction from "./transaction";

import {
  MISSING_DOC,
  REV_CONFLICT,
  NOT_OPEN,
  BAD_ARG,
  MISSING_STUB,
  createError
} from "pouchdb-errors";

var DOC_STORE = "document-store";
var BY_SEQ_STORE = "by-sequence";
var BINARY_STORE = "attach-binary-store";
var LOCAL_STORE = "local-store";
var META_STORE = "meta-store";

// leveldb barks if we try to open a db multiple times
// so we cache opened connections here for initstore()
var dbStores = new Map();

// store the value of update_seq in the by-sequence store the key name will
// never conflict, since the keys in the by-sequence store are integers
var UPDATE_SEQ_KEY = "_local_last_update_seq";
var DOC_COUNT_KEY = "_local_doc_count";
var UUID_KEY = "_local_uuid";

var MD5_PREFIX = "md5-";

var safeJsonEncoding = {
  encode: JSON.stringify,
  decode: JSON.parse,
  buffer: false,
  type: "cheap-json"
};

function binaryMd5(data, callback) {
  var base64 = crypto
    .createHash("md5")
    .update(data, "binary")
    .digest("base64");
  callback(base64);
}

var levelChanges = new Changes();

// winningRev and deleted are performance-killers, but
// in newer versions of PouchDB, they are cached on the metadata
function getWinningRev(metadata) {
  return "winningRev" in metadata
    ? metadata.winningRev
    : calculateWinningRev(metadata);
}

function getIsDeleted(metadata, winningRev) {
  return "deleted" in metadata
    ? metadata.deleted
    : isDeleted(metadata, winningRev);
}

function LevelPouch(opts, callback) {
  opts = clone(opts);
  var api = this;
  var instanceId;
  var stores = {};
  var revLimit = opts.revs_limit;
  var db;
  var name = opts.name;
  // TODO: this is undocumented and unused probably
  /* istanbul ignore else */
  if (typeof opts.createIfMissing === "undefined") {
    opts.createIfMissing = true;
  }

  var leveldown = opts.db;

  var dbStore;
  var leveldownName = functionName(leveldown);
  if (dbStores.has(leveldownName)) {
    dbStore = dbStores.get(leveldownName);
  } else {
    dbStore = new Map();
    dbStores.set(leveldownName, dbStore);
  }
  if (dbStore.has(name)) {
    db = dbStore.get(name);
    afterDBCreated();
  } else {
    dbStore.set(
      name,
      sublevel(
        levelup(leveldown(name), opts, function(err) {
          /* istanbul ignore if */
          if (err) {
            dbStore.delete(name);
            return callback(err);
          }
          db = dbStore.get(name);
          db._docCount = -1;
          db._queue = new Deque();
          /* istanbul ignore else */
          if (typeof opts.migrate === "object") {
            // migration for leveldown
            opts.migrate.doMigrationOne(name, db, afterDBCreated);
          } else {
            afterDBCreated();
          }
        })
      )
    );
  }

  function afterDBCreated() {
    stores.docStore = db.sublevel(DOC_STORE, {
      valueEncoding: safeJsonEncoding
    });
    stores.bySeqStore = db.sublevel(BY_SEQ_STORE, { valueEncoding: "json" });
    stores.binaryStore = db.sublevel(BINARY_STORE, { valueEncoding: "binary" });
    stores.localStore = db.sublevel(LOCAL_STORE, { valueEncoding: "json" });
    stores.metaStore = db.sublevel(META_STORE, { valueEncoding: "json" });
    /* istanbul ignore else */
    if (typeof opts.migrate === "object") {
      // migration for leveldown
      opts.migrate.doMigrationTwo(db, stores, afterLastMigration);
    } else {
      afterLastMigration();
    }
  }

  function afterLastMigration() {
    stores.metaStore.get(UPDATE_SEQ_KEY, function(err, value) {
      if (typeof db._updateSeq === "undefined") {
        db._updateSeq = value || 0;
      }
      stores.metaStore.get(DOC_COUNT_KEY, function(err, value) {
        db._docCount = !err ? value : 0;
        stores.metaStore.get(UUID_KEY, function(err, value) {
          instanceId = !err ? value : uuid();
          stores.metaStore.put(UUID_KEY, instanceId, function() {
            nextTick(function() {
              callback(null, api);
            });
          });
        });
      });
    });
  }

  function countDocs(callback) {
    /* istanbul ignore if */
    if (db.isClosed()) {
      return callback(new Error("database is closed"));
    }
    return callback(null, db._docCount); // use cached value
  }

  api._remote = false;
  /* istanbul ignore next */
  api.type = function() {
    return "leveldb";
  };

  api._id = function(callback) {
    callback(null, instanceId);
  };

  api._info = function(callback) {
    var res = {
      doc_count: db._docCount,
      update_seq: db._updateSeq,
      backend_adapter: functionName(leveldown)
    };
    return nextTick(function() {
      callback(null, res);
    });
  };

  function tryCode(fun, args) {
    try {
      fun.apply(null, args);
    } catch (err) {
      args[args.length - 1](err);
    }
  }

  function executeNext() {
    var firstTask = db._queue.peekFront();

    if (firstTask.type === "read") {
      runReadOperation(firstTask);
    } else {
      // write, only do one at a time
      runWriteOperation(firstTask);
    }
  }

  function runReadOperation(firstTask) {
    // do multiple reads at once simultaneously, because it's safe

    var readTasks = [firstTask];
    var i = 1;
    var nextTask = db._queue.get(i);
    while (typeof nextTask !== "undefined" && nextTask.type === "read") {
      readTasks.push(nextTask);
      i++;
      nextTask = db._queue.get(i);
    }

    var numDone = 0;

    readTasks.forEach(function(readTask) {
      var args = readTask.args;
      var callback = args[args.length - 1];
      args[args.length - 1] = getArguments(function(cbArgs) {
        callback.apply(null, cbArgs);
        if (++numDone === readTasks.length) {
          nextTick(function() {
            // all read tasks have finished
            readTasks.forEach(function() {
              db._queue.shift();
            });
            if (db._queue.length) {
              executeNext();
            }
          });
        }
      });
      tryCode(readTask.fun, args);
    });
  }

  function runWriteOperation(firstTask) {
    var args = firstTask.args;
    var callback = args[args.length - 1];
    args[args.length - 1] = getArguments(function(cbArgs) {
      callback.apply(null, cbArgs);
      nextTick(function() {
        db._queue.shift();
        if (db._queue.length) {
          executeNext();
        }
      });
    });
    tryCode(firstTask.fun, args);
  }

  // all read/write operations to the database are done in a queue,
  // similar to how websql/idb works. this avoids problems such
  // as e.g. compaction needing to have a lock on the database while
  // it updates stuff. in the future we can revisit this.
  function writeLock(fun) {
    return getArguments(function(args) {
      db._queue.push({
        fun: fun,
        args: args,
        type: "write"
      });

      if (db._queue.length === 1) {
        nextTick(executeNext);
      }
    });
  }

  // same as the writelock, but multiple can run at once
  function readLock(fun) {
    return getArguments(function(args) {
      db._queue.push({
        fun: fun,
        args: args,
        type: "read"
      });

      if (db._queue.length === 1) {
        nextTick(executeNext);
      }
    });
  }

  function formatSeq(n) {
    return ("0000000000000000" + n).slice(-16);
  }

  function parseSeq(s) {
    return parseInt(s, 10);
  }

  api._get = readLock(function(id, opts, callback) {
    opts = clone(opts);

    stores.docStore.get(id, function(err, metadata) {
      if (err || !metadata) {
        return callback(createError(MISSING_DOC, "missing"));
      }

      var rev;
      if (!opts.rev) {
        rev = getWinningRev(metadata);
        var deleted = getIsDeleted(metadata, rev);
        if (deleted) {
          return callback(createError(MISSING_DOC, "deleted"));
        }
      } else {
        rev = opts.latest ? getLatest(opts.rev, metadata) : opts.rev;
      }

      var seq = metadata.rev_map[rev];

      stores.bySeqStore.get(formatSeq(seq), function(err, doc) {
        if (!doc) {
          return callback(createError(MISSING_DOC));
        }
        /* istanbul ignore if */
        if ("_id" in doc && doc._id !== metadata.id) {
          // this failing implies something very wrong
          return callback(new Error("wrong doc returned"));
        }
        doc._id = metadata.id;
        if ("_rev" in doc) {
          /* istanbul ignore if */
          if (doc._rev !== rev) {
            // this failing implies something very wrong
            return callback(new Error("wrong doc returned"));
          }
        } else {
          // we didn't always store this
          doc._rev = rev;
        }
        return callback(null, { doc: doc, metadata: metadata });
      });
    });
  });

  api._bulkDocs = writeLock(function(req, opts, callback) {
    var newEdits = opts.new_edits;
    var results = new Array(req.docs.length);
    var fetchedDocs = new Map();
    var stemmedRevs = new Map();

    var txn = new LevelTransaction();
    var docCountDelta = 0;
    var newUpdateSeq = db._updateSeq;

    // parse the docs and give each a sequence number
    var userDocs = req.docs;
    var docInfos = userDocs.map(function(doc) {
      if (doc._id && isLocalId(doc._id)) {
        return doc;
      }
      var newDoc = parseDoc(doc, newEdits, api.__opts);

      if (newDoc.metadata && !newDoc.metadata.rev_map) {
        newDoc.metadata.rev_map = {};
      }

      return newDoc;
    });
    var infoErrors = docInfos.filter(function(doc) {
      return doc.error;
    });

    if (infoErrors.length) {
      return callback(infoErrors[0]);
    }

    function fetchExistingDocs(finish) {
      var numDone = 0;
      var overallErr;
      function checkDone() {
        if (++numDone === userDocs.length) {
          return finish(overallErr);
        }
      }

      userDocs.forEach(function(doc) {
        if (doc._id && isLocalId(doc._id)) {
          // skip local docs
          return checkDone();
        }
        txn.get(stores.docStore, doc._id, function(err, info) {
          if (err) {
            /* istanbul ignore if */
            if (err.name !== "NotFoundError") {
              overallErr = err;
            }
          } else {
            fetchedDocs.set(doc._id, info);
          }
          checkDone();
        });
      });
    }

    function compact(revsMap, callback) {
      var promise = Promise.resolve();
      revsMap.forEach(function(revs, docId) {
        // TODO: parallelize, for now need to be sequential to
        // pass orphaned attachment tests
        promise = promise.then(function() {
          return new Promise(function(resolve, reject) {
            api._doCompactionNoLock(docId, revs, { ctx: txn }, function(err) {
              /* istanbul ignore if */
              if (err) {
                return reject(err);
              }
              resolve();
            });
          });
        });
      });

      promise.then(function() {
        callback();
      }, callback);
    }

    function autoCompact(callback) {
      var revsMap = new Map();
      fetchedDocs.forEach(function(metadata, docId) {
        revsMap.set(docId, compactTree(metadata));
      });
      compact(revsMap, callback);
    }

    function finish() {
      compact(stemmedRevs, function(error) {
        /* istanbul ignore if */
        if (error) {
          complete(error);
        }
        if (api.auto_compaction) {
          return autoCompact(complete);
        }
        complete();
      });
    }

    function writeDoc(
      docInfo,
      winningRev,
      winningRevIsDeleted,
      newRevIsDeleted,
      isUpdate,
      delta,
      resultsIdx,
      callback2
    ) {
      docCountDelta += delta;

      var err = null;
      var recv = 0;

      docInfo.metadata.winningRev = winningRev;
      docInfo.metadata.deleted = winningRevIsDeleted;

      docInfo.data._id = docInfo.metadata.id;
      docInfo.data._rev = docInfo.metadata.rev;

      if (newRevIsDeleted) {
        docInfo.data._deleted = true;
      }

      if (docInfo.stemmedRevs.length) {
        stemmedRevs.set(docInfo.metadata.id, docInfo.stemmedRevs);
      }

      function finish() {
        var seq = docInfo.metadata.rev_map[docInfo.metadata.rev];
        /* istanbul ignore if */
        if (seq) {
          // check that there aren't any existing revisions with the same
          // revision id, else we shouldn't do anything
          return callback2();
        }
        seq = ++newUpdateSeq;
        docInfo.metadata.rev_map[
          docInfo.metadata.rev
        ] = docInfo.metadata.seq = seq;
        var seqKey = formatSeq(seq);
        var batch = [
          {
            key: seqKey,
            value: docInfo.data,
            prefix: stores.bySeqStore,
            type: "put"
          },
          {
            key: docInfo.metadata.id,
            value: docInfo.metadata,
            prefix: stores.docStore,
            type: "put"
          }
        ];
        txn.batch(batch);
        results[resultsIdx] = {
          ok: true,
          id: docInfo.metadata.id,
          rev: docInfo.metadata.rev
        };
        fetchedDocs.set(docInfo.metadata.id, docInfo.metadata);
        callback2();
      }

      finish();
    }

    function complete(err) {
      /* istanbul ignore if */
      if (err) {
        return nextTick(function() {
          callback(err);
        });
      }
      txn.batch([
        {
          prefix: stores.metaStore,
          type: "put",
          key: UPDATE_SEQ_KEY,
          value: newUpdateSeq
        },
        {
          prefix: stores.metaStore,
          type: "put",
          key: DOC_COUNT_KEY,
          value: db._docCount + docCountDelta
        }
      ]);
      txn.execute(db, function(err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        db._docCount += docCountDelta;
        db._updateSeq = newUpdateSeq;
        levelChanges.notify(name);
        nextTick(function() {
          callback(null, results);
        });
      });
    }

    if (!docInfos.length) {
      return callback(null, []);
    }


    fetchExistingDocs(function (err) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      processDocs(revLimit, docInfos, api, fetchedDocs, txn, results,
                  writeDoc, opts, finish);
    });    

  });
  api._allDocs = function(opts, callback) {
    if ("keys" in opts) {
      return allDocsKeysQuery(this, opts);
    }
    return readLock(function(opts, callback) {
      opts = clone(opts);
      countDocs(function(err, docCount) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        var readstreamOpts = {};
        var skip = opts.skip || 0;
        if (opts.startkey) {
          readstreamOpts.gte = opts.startkey;
        }
        if (opts.endkey) {
          readstreamOpts.lte = opts.endkey;
        }
        if (opts.key) {
          readstreamOpts.gte = readstreamOpts.lte = opts.key;
        }
        if (opts.descending) {
          readstreamOpts.reverse = true;
          // switch start and ends
          var tmp = readstreamOpts.lte;
          readstreamOpts.lte = readstreamOpts.gte;
          readstreamOpts.gte = tmp;
        }
        var limit;
        if (typeof opts.limit === "number") {
          limit = opts.limit;
        }
        if (
          limit === 0 ||
          ("gte" in readstreamOpts &&
            "lte" in readstreamOpts &&
            readstreamOpts.gte > readstreamOpts.lte)
        ) {
          // should return 0 results when start is greater than end.
          // normally level would "fix" this for us by reversing the order,
          // so short-circuit instead
          var returnVal = {
            total_rows: docCount,
            offset: opts.skip,
            rows: []
          };
          /* istanbul ignore if */
          if (opts.update_seq) {
            returnVal.update_seq = db._updateSeq;
          }
          return callback(null, returnVal);
        }
        var results = [];
        var docstream = stores.docStore.readStream(readstreamOpts);

        var throughStream = through(
          function(entry, _, next) {
            var metadata = entry.value;
            // winningRev and deleted are performance-killers, but
            // in newer versions of PouchDB, they are cached on the metadata
            var winningRev = getWinningRev(metadata);
            var deleted = getIsDeleted(metadata, winningRev);
            if (!deleted) {
              if (skip-- > 0) {
                next();
                return;
              } else if (typeof limit === "number" && limit-- <= 0) {
                docstream.unpipe();
                docstream.destroy();
                next();
                return;
              }
            } else if (opts.deleted !== "ok") {
              next();
              return;
            }
            function allDocsInner(data) {
              var doc = {
                id: metadata.id,
                key: metadata.id,
                value: {
                  rev: winningRev
                }
              };
              if (opts.include_docs) {
                doc.doc = data;
                doc.doc._rev = doc.value.rev;
                if (opts.conflicts) {
                  var conflicts = collectConflicts(metadata);
                  if (conflicts.length) {
                    doc.doc._conflicts = conflicts;
                  }
                }
              }
              if (opts.inclusive_end === false && metadata.id === opts.endkey) {
                return next();
              } else if (deleted) {
                if (opts.deleted === "ok") {
                  doc.value.deleted = true;
                  doc.doc = null;
                } else {
                  /* istanbul ignore next */
                  return next();
                }
              }
              results.push(doc);
              next();
            }
            if (opts.include_docs) {
              var seq = metadata.rev_map[winningRev];
              stores.bySeqStore.get(formatSeq(seq), function(err, data) {
                allDocsInner(data);
              });
            } else {
              allDocsInner();
            }
          },
          function(next) {
            Promise.resolve().then(function() {
              var returnVal = {
                total_rows: docCount,
                offset: opts.skip,
                rows: results
              };

              /* istanbul ignore if */
              if (opts.update_seq) {
                returnVal.update_seq = db._updateSeq;
              }
              callback(null, returnVal);
            }, callback);
            next();
          }
        ).on("unpipe", function() {
          throughStream.end();
        });

        docstream.on("error", callback);

        docstream.pipe(throughStream);
      });
    })(opts, callback);
  };

  api._changes = function(opts) {
    opts = clone(opts);

    if (opts.continuous) {
      var id = name + ":" + uuid();
      levelChanges.addListener(name, id, api, opts);
      levelChanges.notify(name);
      return {
        cancel: function() {
          levelChanges.removeListener(name, id);
        }
      };
    }

    var descending = opts.descending;
    var results = [];
    var lastSeq = opts.since || 0;
    var called = 0;
    var streamOpts = {
      reverse: descending
    };
    var limit;
    if ("limit" in opts && opts.limit > 0) {
      limit = opts.limit;
    }
    if (!streamOpts.reverse) {
      streamOpts.start = formatSeq(opts.since || 0);
    }

    var docIds = opts.doc_ids && new Set(opts.doc_ids);
    var filter = filterChange(opts);
    var docIdsToMetadata = new Map();

    function complete() {
      opts.done = true;
      if (opts.return_docs && opts.limit) {
        /* istanbul ignore if */
        if (opts.limit < results.length) {
          results.length = opts.limit;
        }
      }
      changeStream.unpipe(throughStream);
      changeStream.destroy();
      if (!opts.continuous && !opts.cancelled) {
        opts.complete(null, { results: results, last_seq: lastSeq });
      }
    }
    var changeStream = stores.bySeqStore.readStream(streamOpts);
    var throughStream = through(
      function(data, _, next) {
        if (limit && called >= limit) {
          complete();
          return next();
        }
        if (opts.cancelled || opts.done) {
          return next();
        }

        var seq = parseSeq(data.key);
        var doc = data.value;

        if (seq === opts.since && !descending) {
          // couchdb ignores `since` if descending=true
          return next();
        }

        if (docIds && !docIds.has(doc._id)) {
          return next();
        }

        var metadata;

        function onGetMetadata(metadata) {
          var winningRev = getWinningRev(metadata);

          function onGetWinningDoc(winningDoc) {
            var change = opts.processChange(winningDoc, metadata, opts);
            change.seq = metadata.seq;

            var filtered = filter(change);
            if (typeof filtered === "object") {
              return opts.complete(filtered);
            }

            if (filtered) {
              called++;

              opts.onChange(change);

              if (opts.return_docs) {
                results.push(change);
              }
            }
            next();
          }

          if (metadata.seq !== seq) {
            // some other seq is later
            return next();
          }

          lastSeq = seq;

          if (winningRev === doc._rev) {
            return onGetWinningDoc(doc);
          }

          // fetch the winner

          var winningSeq = metadata.rev_map[winningRev];

          stores.bySeqStore.get(formatSeq(winningSeq), function(err, doc) {
            onGetWinningDoc(doc);
          });
        }

        metadata = docIdsToMetadata.get(doc._id);
        if (metadata) {
          // cached
          return onGetMetadata(metadata);
        }
        // metadata not cached, have to go fetch it
        stores.docStore.get(doc._id, function(err, metadata) {
          /* istanbul ignore if */
          if (
            opts.cancelled ||
            opts.done ||
            db.isClosed() ||
            isLocalId(metadata.id)
          ) {
            return next();
          }
          docIdsToMetadata.set(doc._id, metadata);
          onGetMetadata(metadata);
        });
      },
      function(next) {
        if (opts.cancelled) {
          return next();
        }
        if (opts.return_docs && opts.limit) {
          /* istanbul ignore if */
          if (opts.limit < results.length) {
            results.length = opts.limit;
          }
        }

        next();
      }
    ).on("unpipe", function() {
      throughStream.end();
      complete();
    });
    changeStream.pipe(throughStream);
    return {
      cancel: function() {
        opts.cancelled = true;
        complete();
      }
    };
  };

  api._close = function(callback) {
    /* istanbul ignore if */
    if (db.isClosed()) {
      return callback(createError(NOT_OPEN));
    }
    db.close(function(err) {
      /* istanbul ignore if */
      if (err) {
        callback(err);
      } else {
        dbStore.delete(name);
        callback();
      }
    });
  };

  api._getRevisionTree = function(docId, callback) {
    stores.docStore.get(docId, function(err, metadata) {
      if (err) {
        callback(createError(MISSING_DOC));
      } else {
        callback(null, metadata.rev_tree);
      }
    });
  };

  api._doCompaction = writeLock(function(docId, revs, opts, callback) {
    api._doCompactionNoLock(docId, revs, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._doCompactionNoLock = function(docId, revs, opts, callback) {
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }

    if (!revs.length) {
      return callback();
    }
    var txn = opts.ctx || new LevelTransaction();

    txn.get(stores.docStore, docId, function(err, metadata) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      var seqs = revs.map(function(rev) {
        var seq = metadata.rev_map[rev];
        delete metadata.rev_map[rev];
        return seq;
      });
      traverseRevTree(metadata.rev_tree, function(
        isLeaf,
        pos,
        revHash,
        ctx,
        opts
      ) {
        var rev = pos + "-" + revHash;
        if (revs.indexOf(rev) !== -1) {
          opts.status = "missing";
        }
      });

      var batch = [];
      batch.push({
        key: metadata.id,
        value: metadata,
        type: "put",
        prefix: stores.docStore
      });

      var digestMap = {};
      var numDone = 0;
      var overallErr;
      function checkDone(err) {
        /* istanbul ignore if */
        if (err) {
          overallErr = err;
        }
        if (++numDone === revs.length) {
          // done
          /* istanbul ignore if */
          if (overallErr) {
            return callback(overallErr);
          }
        }
      }

      function finish(err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        txn.batch(batch);
        if (opts.ctx) {
          // don't execute immediately
          return callback();
        }
        txn.execute(db, callback);
      }

      seqs.forEach(function(seq) {
        batch.push({
          key: formatSeq(seq),
          type: "del",
          prefix: stores.bySeqStore
        });
        txn.get(stores.bySeqStore, formatSeq(seq), function(err, doc) {
          /* istanbul ignore if */
          if (err) {
            if (err.name === "NotFoundError") {
              return checkDone();
            } else {
              return checkDone(err);
            }
          }
          checkDone();
        });
      });
    });
  };

  api._getLocal = function(id, callback) {
    stores.localStore.get(id, function(err, doc) {
      if (err) {
        callback(createError(MISSING_DOC));
      } else {
        callback(null, doc);
      }
    });
  };

  api._putLocal = function(doc, opts, callback) {
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }
    if (opts.ctx) {
      api._putLocalNoLock(doc, opts, callback);
    } else {
      api._putLocalWithLock(doc, opts, callback);
    }
  };

  api._putLocalWithLock = writeLock(function(doc, opts, callback) {
    api._putLocalNoLock(doc, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._putLocalNoLock = function(doc, opts, callback) {
    delete doc._revisions; // ignore this, trust the rev
    var oldRev = doc._rev;
    var id = doc._id;

    var txn = opts.ctx || new LevelTransaction();

    txn.get(stores.localStore, id, function(err, resp) {
      if (err && oldRev) {
        return callback(createError(REV_CONFLICT));
      }
      if (resp && resp._rev !== oldRev) {
        return callback(createError(REV_CONFLICT));
      }
      doc._rev = oldRev
        ? "0-" + (parseInt(oldRev.split("-")[1], 10) + 1)
        : "0-1";
      var batch = [
        {
          type: "put",
          prefix: stores.localStore,
          key: id,
          value: doc
        }
      ];

      txn.batch(batch);
      var ret = { ok: true, id: doc._id, rev: doc._rev };

      if (opts.ctx) {
        // don't execute immediately
        return callback(null, ret);
      }
      txn.execute(db, function(err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        callback(null, ret);
      });
    });
  };

  api._removeLocal = function(doc, opts, callback) {
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }
    if (opts.ctx) {
      api._removeLocalNoLock(doc, opts, callback);
    } else {
      api._removeLocalWithLock(doc, opts, callback);
    }
  };

  api._removeLocalWithLock = writeLock(function(doc, opts, callback) {
    api._removeLocalNoLock(doc, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._removeLocalNoLock = function(doc, opts, callback) {
    var txn = opts.ctx || new LevelTransaction();
    txn.get(stores.localStore, doc._id, function(err, resp) {
      if (err) {
        /* istanbul ignore if */
        if (err.name !== "NotFoundError") {
          return callback(err);
        } else {
          return callback(createError(MISSING_DOC));
        }
      }
      if (resp._rev !== doc._rev) {
        return callback(createError(REV_CONFLICT));
      }
      txn.batch([
        {
          prefix: stores.localStore,
          type: "del",
          key: doc._id
        }
      ]);
      var ret = { ok: true, id: doc._id, rev: "0-0" };
      if (opts.ctx) {
        // don't execute immediately
        return callback(null, ret);
      }
      txn.execute(db, function(err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        callback(null, ret);
      });
    });
  };

  // close and delete open leveldb stores
  api._destroy = function(opts, callback) {
    var dbStore;
    var leveldownName = functionName(leveldown);
    /* istanbul ignore else */
    if (dbStores.has(leveldownName)) {
      dbStore = dbStores.get(leveldownName);
    } else {
      return callDestroy(name, callback);
    }

    /* istanbul ignore else */
    if (dbStore.has(name)) {
      levelChanges.removeAllListeners(name);

      dbStore.get(name).close(function() {
        dbStore.delete(name);
        callDestroy(name, callback);
      });
    } else {
      callDestroy(name, callback);
    }
  };
  function callDestroy(name, cb) {
    // May not exist if leveldown is backed by memory adapter
    /* istanbul ignore else */
    if ("destroy" in leveldown) {
      leveldown.destroy(name, cb);
    } else {
      cb(null);
    }
  }
}

export default LevelPouch;
