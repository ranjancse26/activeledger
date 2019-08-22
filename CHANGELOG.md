# Activeledger Changelog

## [2.1.1]

### Bug Fixes
* **Protocol:** No longer selects the incorrect VM container on initalisation of a broadcast transaction type.

## [2.1.0]

### Bug Fixes
* **Activeledger:** Improved build script (npm rum setup).
* **Contracts:** Unhandled rejections sent back to transaction client request.
* **Logger:** PID is now padded to align logs.
* **Logger:** Logs message improvements.

### Features
* **Activeledger:** Node 12 Support.
* **Activeledger:** ES2018 Builds.
* **Core:** Refactored to use Httpd package.
* **Httpd:** New HTTP server.
* **Protocol:** Refactored to improve maintainability.
* **Storage:** Custom PouchDB build for self hosted data storage.

### Performance Improvements
* **Logger:** Moved some INFO logs to DEBUG.
* **Network:** Improved processor handling for running transactions simultaneously.
* **Network:** Improved internal IPC calls / Emitted Events between processes.
* **Protocol:** New VM container which is reusable for multiple contract executions.
* **Protocol:** Fetches all related stream data per transaction as one batch.
* **Protocol:** Volatile stream data is now on demand.
* **Restore:** Converted promises to async / awaits.


### BREAKING CHANGES
* **Contracts:** [activity].getVolatile() now returns as a promise to return the data instead of returning the data synchronously.