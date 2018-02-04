## Description

- This module is for keeping those very common, none business logic related util methods.

## Note

1. Since it seems bitbucket branch tag doesn't work for `npm install`, so we use master branch.

## Memo

```javascript
/*
 * Basically this function done the wrap job for Node.js async lib -> 'parallel' kinds API, more details can refer here:
 *   http://www.sebastianseilund.com/nodejs-async-in-practice
 * 
 * gprc hasn't support 'Promise' yet, and the api also cannot be promisified, so I fall back to async, sad!
 *
 */
static funcWrapperForAsync(func) {
  if (!func || typeof func !== 'function') {
    throw new Error('Parameter must be a function.');
  }
  return (callback) => {
    func.call(arguments, (err, res) => {
      if (err) {
        return callback(err);
      }
      return callback(null, res);
    });
  };
}


/*
 * Service id format:
 *   serviceTag+pid+localIp:port
 */
static generateServiceId(serviceTag, pid, port) {
  if (!serviceTag || typeof serviceTag !== 'string' || serviceTag.trim().length === 0) {
    throw new Error('Invalid service tag provided.');
  }
  if (!Number.isInteger(pid) || !Number.isInteger(port) || pid < 0 || port < 0) {
    throw new Error('Invalid pid or port number provided.');
  }
  return this.getLocalIp().spread((address, family) => {
    return serviceTag + '+' + pid + '+' + address + ':' + port;
  });
}

static registerToConsul(consulAgent, serviceTag, pid, port, checks) {
  Promise.join(this.getLocalIp(), this.generateServiceId(serviceTag, pid, port), (ipInfo, serviceId) => {
    const _registerToConsul = () => {
      return consulAgent.agent.service.register({
        name: serviceId,
        id: serviceId,
        tags: [serviceTag, require('os').hostname()],
        address: ipInfo[0],
        port: port,
        checks: checks
      }).catch((err) => {
        return Promise.reject(err);
      });
    };

    setTimeout(() => {
      retry(_registerToConsul, {
        interval: 100,
        max_tries: 65535
      });
    }, Math.random() * 1000);
  });
}

static queryServiceByTag(consulAgent, serviceTagArr) {

  return consulAgent.catalog.service.list().then((res) => {

    const serviceGroupedByTag = serviceTagArr.reduce((acc, curr) => {
      acc[curr] = [];
      return acc;
    }, {});

    return Object.keys(res).reduce((acc, curr) => {
      const intersection = res[curr].filter((item) => {
        return serviceTagArr.indexOf(item) !== -1;
      });
      if (intersection.length) {
        acc[intersection[0]].push(curr);
      }
      return acc;
    }, serviceGroupedByTag);

  });

}

static getLocalIp() {
  return Promise.promisify(require('dns').lookup, {multiArgs: true})(require('os').hostname());
}
```