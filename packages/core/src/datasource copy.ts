/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { QueryEngine } from "@activeledger/activequery";
import {
  ActiveOptions,
  ActiveDSConnect,
  ActiveChanges
} from "@activeledger/activeoptions";
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveNetwork } from "@activeledger/activenetwork";
import { EventEmitter } from 'events';
// Add Find Plugin

export class ActiveledgerDatasource {
  /**
   * DS Connection
   *
   * @private
   * @static
   * @type {*}
   * @memberof ActiveledgerDatasource
   */
  private static db: ActiveDSConnect;

  /**
   * DS Connection to event store
   *
   * @private
   * @static
   * @type {*}
   * @memberof ActiveledgerDatasource
   */
  private static dbEvents: ActiveDSConnect;

  /**
   * Follows changes from the ledger
   *
   * @private
   * @static
   * @type {ActiveChanges}
   * @memberof ActiveledgerDatasource
   */
  private static changes: ActiveChanges;

  /**
   * Follows events from the ledger
   *
   * @private
   * @static
   * @type {ActiveChanges}
   * @memberof ActiveledgerDatasource
   */
  private static events: ActiveChanges;

  /**
   * DB Query Engine
   *
   * @private
   * @static
   * @type {QueryEngine}
   * @memberof ActiveledgerDatasource
   */
  private static query: QueryEngine;

  /**
   * Object of known network neighbour nodes
   *
   * @private
   * @static
   * @type {{}}
   * @memberof ActiveledgerDatasource
   */
  private static neighbourhood: any;

  /**
   * Reference to itself in the neighbourhood
   *
   * @private
   * @static
   * @type {*}
   * @memberof ActiveledgerDatasource
   */
  private static selfNeighbour: ActiveNetwork.Home;

  /**
   * Filter out stream and volatile feeds
   *
   * @private
   * @param {*} doc
   * @param {*} req
   * @returns {boolean}
   * @memberof Activity
   */
  private static filter(doc: any): boolean {
    return doc.$stream || doc._id.indexOf(":") !== -1 ? false : true;
  }

  private static emitter: EventEmitter;

  /**
   * Get Database Connection
   *
   * @static
   * @returns
   * @memberof ActiveledgerDatasource
   */
  public static getDb() {
    if (!this.db) {
      // Self Hosted?
      if (ActiveOptions.get<any>("db", {}).selfhost) {
        // Get Database
        let db = ActiveOptions.get<any>("db", {});

        // Set Url
        db.url = "http://127.0.0.1:" + db.selfhost.port;

        // We can also update the path to override the default couch install
        db.path = db.selfhost.dir || "./.ds";

        // Set Database
        ActiveOptions.set("db", db);
      }

      // Create Database Connections
      this.db = new ActiveDSConnect(
        ActiveOptions.get<any>("db", {}).url +
          "/" +
          ActiveOptions.get<any>("db", {}).database
      );

      this.dbEvents = new ActiveDSConnect(
        ActiveOptions.get<any>("db", {}).url +
          "/" +
          ActiveOptions.get<any>("db", {}).event
      );

      // Add Query Engine
      this.query = new QueryEngine(
        this.db,
        false,
        ActiveOptions.get<number>("queryLimit", 0)
      );
      this.emitter = new EventEmitter();

      // Add Changes Watcher
      this.changes = new ActiveChanges("Activities", this.db);
      this.changes.start("now");
      this.changes.on("change", (change:any) => {
        this.emitter.emit("change", change);
      })

      // Add Events Watcher
      this.events = new ActiveChanges("Events", this.dbEvents);
      this.events.start("now");
      this.changes.on("change", (event:any) => {
        this.emitter.emit("event", event);
      })


      
    }
    return this.db;
  }

  /**
   * Returns Query Engine
   *
   * @static
   * @returns {QueryEngine}
   * @memberof ActiveledgerDatasource
   */
  public static getQuery(): QueryEngine {
    // Make sure we have db connection
    this.getDb();

    // Return Query Object
    return this.query;
  }

  /**
   * Returns Change Object
   *
   * @static
   * @returns {*}
   * @memberof ActiveledgerDatasource
   */
  public static getChanges(lastEventId: string): EventEmitter {
    // Make sure we have db connection
    this.getDb();

    // Make sure we are listening
    //this.changes.start(lastEventId);

    // Return Query Object
    return this.emitter;
  }

  /**
   * Returns Events Object
   *
   * @static
   * @returns {*}
   * @memberof ActiveledgerDatasource
   */
  public static getEvents(lastEventId: string): EventEmitter {
    // Make sure we have db connection
    this.getDb();

    // Make sure we are listening
    //this.events.start(lastEventId);

    // Return Query Object
    return this.emitter;
  }

  /**
   * Get Mocked neighbourhood object
   *
   * @static
   * @returns {{}}
   * @memberof ActiveledgerDatasource
   */
  public static getNeighbourhood(): {} {
    if (!this.neighbourhood) {
      this.neighbourhood = {};
      // Build neighbourhood from options
      let neighbourhood: Array<any> = ActiveOptions.get("neighbourhood", false);

      // Loop all neighbour nodes and prepare for Securesd output
      let i = neighbourhood.length;
      while (i--) {
        // Generate same reference
        let ref = ActiveCrypto.Hash.getHash(
          neighbourhood[i].host +
            neighbourhood[i].port +
            ActiveOptions.get<string>("network", ""),
          "sha1"
        );

        this.neighbourhood[ref] = {
          identity: {
            pem: neighbourhood[i].identity.public
          }
        };
      }
    }
    return this.neighbourhood;
  }

  /**
   * Get Mocked Home object
   *
   * @static
   * @returns {{}}
   * @memberof ActiveledgerDatasource
   */
  public static getSelfNeighbour(): {} {
    if (!this.selfNeighbour) {
      this.selfNeighbour = new ActiveNetwork.Home();
    }
    return this.selfNeighbour;
  }
}
