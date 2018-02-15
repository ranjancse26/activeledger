import { Query, Activity } from "activecontracts";
import { ActiveLogger } from "activelogger";

/**
 * Default Onboarding (New Account) contract
 *
 * @export
 * @class Onboard
 * @extends {Standard}
 */
export default class Namespace extends Query {
  /**
   * Requested Namespace
   *
   * @private
   * @type string
   * @memberof Fund
   */
  private namespace: string;


  /**
   * Reference input stream name
   * 
   * @private
   * @type {string}
   * @memberof Namespace
   */
  private identity: Activity


  /**
   * Quick Check, Allow all data but make sure it is signatureless
   *
   * @param {boolean} signatureless
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public verify(signatureless: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (!signatureless) {
        resolve(true);
      } else {
        reject("Signatures Needed");
      }
    });
  }

  /**
   * Mostly Testing, So Don't need to check
   *
   * @returns {Promise<boolean>}
   * @memberof Onboard
   */
  public vote(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {

      // Get Stream id
      let stream = Object.keys(this.transactions.$i)[0];

      // Get Stream Activity
      this.identity = this.getActivityStreams(stream);

      // Get namespace and set to lowercase
      this.namespace = (this.transactions.$i[stream]
        .namespace as string).toLowerCase();

      // Default already protected
      if (this.namespace == "default") return reject("Namespace Reserved");

      // Does the namespace exist
      this.query
        .sql(`SELECT * FROM X WHERE namespace = ${this.namespace}`)
        .then(doc => {
          if (doc.length > 0) {
            return reject("Namespace Reserved");
          }
          return resolve(true);
        })
        .catch(() => {
          reject("Query Error");
        });
    });
  }

  /**
   * Prepares the new streams state to be comitted to the ledger
   *
   * @returns {Promise<any>}
   * @memberof Onboard
   */
  public commit(): Promise<any> {
    return new Promise<any>((resolve, reject) => {

      // Update Identity to own namespace
      this.identity.setState({ namespace: this.namespace });

      resolve(true);
    });
  }
}
