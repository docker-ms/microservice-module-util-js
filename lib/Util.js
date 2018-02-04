'use strict';

const fs = require('fs');
const path = require('path');
const Promise = require('bluebird');
const bluebirdRetry = require('bluebird-retry');
const mkdirp = require('mkdirp');

const mobilePhone = require('phone');
const countries = require('country-data').countries;

const i18n = require('microservice-i18n');

class Util {

  static get commonSeparator() {
    return 'ಠ';
  }

  static get nthDayOfEpoch() {
    return ~~(+new Date() / 1000 / 60 / 60 / 24);
  }

  static genRandomSeq(len) {
    if (Number.isInteger(len) && len > 0) {
      return Array(len).fill('x').join('').replace(/x/g, function(c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    } else {
      throw new Error('Required length must be a integer greater than 0.');
    }
  }

  static pickRandomly(candidatesArr) {
    if (!candidatesArr || !Array.isArray(candidatesArr) || candidatesArr.length === 0) {
      throw new Error('Parameter must be a nonempty candiates array.');
    }

    if (candidatesArr.length === 1) {
      return candidatesArr[0];
    }

    return candidatesArr[Math.floor(Math.random() * candidatesArr.length)];
  }

  static getRandomIntFromRange(min, max) {
    const hasValidMin = this.verifyAndNormalizeNumber(min);
    const hasValidMax = this.verifyAndNormalizeNumber(max);
    if ((!hasValidMin && hasValidMin !== 0) || (!hasValidMax && hasValidMax !== 0)) {
      throw new Error('Range min and max must be specified with numeric value.');
    }

    const floor = Math.ceil(min);
    const ceil = Math.floor(max);

    if (ceil - floor <= 0) {
      throw new Error('Specified range must at least contain two intergers.');
    }

    return Math.floor(Math.random() * (ceil - floor + 1)) + floor;
  }

  static underscoreToCamel(underscoreName) {
    if (!underscoreName || typeof underscoreName !== 'string') {
      throw new Error('Parameter must be a string separated by underscore.');
    }
    return underscoreName.replace(/_([a-z])/g, (g) => {
      return g[1].toUpperCase();
    });
  }

  static deregisterFromConsul(consulAgents, serviceId) {
    const _deregisterFromConsul = () => {
      const deregisterOps = consulAgents.reduce((acc, curr) => {
        acc.push(curr.agent.service.deregister(serviceId));
        return acc;
      }, []);
      return Promise.all(deregisterOps).catch((err) => {
        return Promise.reject(err);
      });
    };
    this.bluebirdRetryExecutor(_deregisterFromConsul, {})
  }

  static queryServicesByServiceNamePrefix(consulAgent, serviceNamePrefixArr) {

    return consulAgent.catalog.service.list().then((res) => {

      return Object.keys(res).reduce((acc, curr) => {
        serviceNamePrefixArr.forEach((serviceNamePrefix) => {
          if (curr.startsWith(serviceNamePrefix)) {
            if (!acc[serviceNamePrefix]) {
              acc[serviceNamePrefix] = [];
            }
            if (process.env.SERVICE_TAG_SUFFIX && process.env.SERVICE_TAG_SUFFIX.indexOf('localhost') > -1) {
              acc[serviceNamePrefix].push(curr.substring(curr.lastIndexOf('@') + 1, curr.length));
            } else {
              acc[serviceNamePrefix].push(curr.substring(0, curr.indexOf('@')));
            }
          }
        });
        return acc;
      }, {});

    });
  }

  static healthCheck(call, callback) {
    callback(null, {msServiceTag: process.env.MS_SERVICE_TAG});
  }

  static queryServiceByName(consulAgents, serviceNameArr) {

    const serviceGroupedByName = {};

    const doQuery = serviceNameArr.reduce((acc, curr) => {
      serviceGroupedByName[curr] = [];
      acc.push(
        this.pickRandomly(consulAgents).catalog.service.nodes(curr)
      );
      return acc;
    }, []);

    return Promise.all(doQuery).then((services) => {
      return services.reduce((acc, curr) => {
        if (curr.length) {
          curr.forEach((service) => {
            const host = service.ServiceName.indexOf('localhost') > -1 ? 'localhost' : service.ServiceAddress;
            acc[service.ServiceName].push({
              serviceId: service.ServiceID,
              serviceAddr: host + ':' + service.ServicePort
            });
          });
        }
        return acc;
      }, serviceGroupedByName);
    });

  }

  static getLatestAliveGrpcClientsAndRemoveDeadServices(consulAgents, requiredServiceNameArr, grpc, protos) {

    if (!consulAgents || !requiredServiceNameArr || !grpc || !protos) {
      return Promise.reject(new Error("All parameters: 'consulAgents', 'requiredServiceNameArr', 'grpc', 'protos' are required."));
    }
    if (!Array.isArray(requiredServiceNameArr) || requiredServiceNameArr.length === 0) {
      return Promise.reject(new Error("Parameter 'requiredServiceNameArr' must be a nonempty array."));
    }

    return this.queryServiceByName(consulAgents, requiredServiceNameArr).then((serviceGroupedByName) => {

      const serviceIds = [];
      const grpcClients = [];

      const healthChecks = Object.keys(serviceGroupedByName).reduce((acc, curr) => {
        if (serviceGroupedByName[curr].length) {
          const protoPackage = this.underscoreToCamel(curr.substring(0, curr.indexOf('-')));
          const serviceName = protoPackage.charAt(0).toUpperCase() + protoPackage.slice(1);

          const proto = grpc.load({
            root: protos.root,
            file: protos[protoPackage]
          }).microservice[protoPackage];

          serviceGroupedByName[curr].forEach((service) => {
            const grpcClient = new proto[serviceName](service.serviceAddr, grpc.credentials.createInsecure());

            grpcClients.push(grpcClient);
            serviceIds.push(service.serviceId);

            acc.push(
              new Promise((resolve, reject) => {
                grpcClient.healthCheck({}, (err, data) => {
                  if (err) {
                    return reject(err);
                  }
                  return resolve(data);
                });
              })
            );
          });
        }
        return acc;
      }, []);

      const aliveGrpcClients = {};
      const removeDeadServices = [];

      // Test every grpc client with 'healthCheck' api.
      return Promise.all(healthChecks.map((promise) => {
        return promise.reflect();
      })).each((inspection, idx) => {
        if (inspection.isFulfilled()) {
          if (!aliveGrpcClients[inspection.value().msServiceTag]) {
            aliveGrpcClients[inspection.value().msServiceTag] = [];
          }
          aliveGrpcClients[inspection.value().msServiceTag].push(grpcClients[idx]);
        }
      }).then(() => {
        Promise.all(removeDeadServices).then(() => {
          // Nothing need to be done here.
        }).catch((err) => {
          // TODO: maybe record the error?
        });
        return Promise.resolve(aliveGrpcClients);
      }).catch((err) => {
        return Promise.reject(err);
      });

    });
  }

  /*
   * Write consul data which is defined by 'key' to 'path.join(__dirname, basePath, filename)'.
   */
  static writeConsulDataToFile(consulAgents, key, basePath, filename) {
    const _writeToDest = () => {
      return Promise.join(
        Promise.promisify(mkdirp)(basePath),
        this.pickRandomly(consulAgents).kv.get(key),
        (placeholder, data) => {
          if (data && data.Value) {
            return Promise.promisify(fs.writeFile)(path.join(basePath, filename), data.Value).catch((err) => {
              return Promise.reject(err);
            });
          } else {
            return Promise.reject(new Error(`Cannot successfully load the TLS certificate defined by ${key} from consul`));
          }
        }
      ).catch((err) => {
        return Promise.reject(err);
      });
    };

    this.bluebirdRetryExecutor(_writeToDest, {context: this});
  }

  /*
   * For object: the key which is defined in the exclude array will also be deleted.
   * For array: the value which is put in the exclude array will also be deleted.
   */
  static cleanup(obj, exclude) {
    if (obj) {
      if (Array.isArray(obj)) {
        let i = obj.length - 1;
        while (i >= 0) {
          if (obj[i] === null
              || obj[i] === undefined
              || (typeof obj[i] === 'string' && obj[i].trim().length === 0)
              || (Array.isArray(obj[i]) && obj[i].length === 0)
              || (typeof obj[i] === 'object' && Object.keys(obj[i]).length === 0)
              || (Array.isArray(exclude) && exclude.indexOf(obj[i]) !== -1)) {
            obj.splice(i, 1);
          } else if (Array.isArray(obj[i]) || typeof obj[i] === 'object') {
            this.cleanup(obj[i]);
          } else if (typeof obj[i] === 'string') {
            obj[i] = obj[i].trim();
          }
          i--;
        }
      } else if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        let i = keys.length - 1;
        while (i >= 0) {
          if (obj[keys[i]] === null
              || obj[keys[i]] === undefined
              || (typeof obj[keys[i]] === 'string' && obj[keys[i]].trim().length === 0)
              || (Array.isArray(obj[keys[i]]) && obj[keys[i]].length === 0)
              || (typeof obj[keys[i]] === 'object' && Object.keys(obj[keys[i]]).length === 0)
              || (Array.isArray(exclude) && exclude.indexOf(keys[i]) !== -1)) {
            delete obj[keys[i]];
          } else if (Array.isArray(obj[keys[i]]) || typeof obj[keys[i]] === 'object') {
            this.cleanup(obj[keys[i]]);
          } else if (typeof obj[keys[i]] === 'string') {
            obj[keys[i]] = obj[keys[i]].trim();
          }
          i--;
        }
      }
    }
  }

  /*
   * Embedded levels are not supported.
   */
  static copyWithoutProperties(obj, exclude) {
    if (!obj || Array.isArray(obj) || !Array.isArray(exclude) || exclude.length == 0) {
      return obj;
    } else if (typeof obj === 'object') {
      return Object.keys(obj).reduce((acc, curr) => {
        if (exclude.indexOf(curr) === -1) {
          acc[curr] = obj[curr];
        }
        return acc;
      }, {});
    } else {
      return obj;
    }
  }

  static sendEmail(mailerAgent, to, lang, tplRelated) {
    const mailOpts = {
      from: mailerAgent.fromAddr,
      to: to,
      subject: i18n.i18nInternal.__({phrase: `${tplRelated.tplId}.subject`, locale: lang}, tplRelated.subject),
      html: i18n.i18nInternal.__({phrase: `${tplRelated.tplId}.htmlBody`, locale: lang}, tplRelated.htmlBody)
    };
    return new Promise((resolve, reject) => {
      mailerAgent.mailer.sendMail(mailOpts, (err, info) => {
        if (err) {
          return reject(err);
        } else {
          return resolve(info);
        }
      });
    });
  }

  static verifyAndNormalizeNumber(n) {
    if (!isNaN(parseFloat(n)) && isFinite(n)) {
      return Number(n);
    }
    return false;
  }

  static verifyAndNormalizeStr(str) {
    if (!str || typeof str !== 'string' || str.trim().length === 0) {
      return false;
    }
    return str.trim();
  }

  static verifyAndNormalizeEmail(emailAddress) {
    if (this.verifyAndNormalizeStr(emailAddress)) {
      const re = /^(([^<>()\[\]\.,;:\s@\"]+(\.[^<>()\[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i;
      if (re.test(emailAddress.trim())) {
        return emailAddress.trim();
      }
    }
    return false;
  }

  static verifyAndNormalizeMobilePhoneNo(mobilePhoneNo, alpha3CountryCode) {
    if (!this.verifyAndNormalizeNumber(mobilePhoneNo)) {
      return false;
    }
    if (this.verifyAndNormalizeStr(alpha3CountryCode)) {
      alpha3CountryCode = alpha3CountryCode.trim();
    }
    const normalizedMobilePhoneNo = mobilePhone(mobilePhoneNo, alpha3CountryCode);
    if (normalizedMobilePhoneNo.length) {
      return {
        alpha3CountryCode: normalizedMobilePhoneNo[1],
        mobilePhoneNoWithCountryCallingCode: normalizedMobilePhoneNo[0]
      };
    }
    return false;
  }

  static bluebirdRetryExecutor(func, {context, args, interval = 500, timeout = 60000, maxTries = 10}) {
    if (!func || typeof func !== 'function') {
      throw new Error('Please provide the function you want to retry.');
    }
    /*
     * 'args' should be an Array.
     * 'func' will be called like this:
     *   func.apply(context, args);
     */
    return bluebirdRetry(func, {
      context: context,
      args: args,
      predicate: (err) => {
        return err.errCode && err.errCode == 'RR';
      },

      interval: interval,
      timeout: timeout,
      max_tries: maxTries,

      backoff: 2,
      max_interval: 3000,
      throw_original: true
    });
  }

  static apiImplCommonErrorHandler(err, errors, callback) {
    if (err.constructor.name === 'MicroserviceErrorBase') {
      callback({
        code: err.httpStatusCode || 500,
        details: err.errCode
      });
    } else if (err.code === 11000) {
      // E11000 duplicate key error index: microservices.Users.$email_1 dup key: ...
      const duplicateVal4UniqueField = new errors.UniqueRestriction.DuplicateVal4UniqueField();
      callback({
        code: duplicateVal4UniqueField.httpStatusCode || 500,
        details: duplicateVal4UniqueField.errCode
      });
    } else {
      const unknownError = new errors.UnknownError();
      callback({
        code: unknownError.httpStatusCode,
        details: unknownError.errCode
      });
    }
  }

}

module.exports = Util;


