/** @module koast/mongoMapper */
/* global require, exports */

'use strict';

// This module maps connect requests to mongo queries. //

var _ = require('underscore');
var log = null; // mongo-mapper is now an npm package and log gets passed in
var dbUtils = require('koast-db-utils');

var handlerFactories = {};

var errorHandler = function (req, res, error) {
  log.error('Error:', error);
  res.status(500).send('Ooops');
};

/**
 * Sets an alternative error handler function.
 *
 * @param {Function} newHandler    The new error handler function.
 */
exports.setErrorHandler = function (newHandler) {
  errorHandler = newHandler;
};

function prepareQuery(req, options) {
  var query = {};
  // Constrain the query by each param.
  _.keys(req.params).forEach(function (param) {
    query[param] = req.params[param];
  });

  // Constrain the query by each required query field. Throw an error if the
  // value is not supplied.
  if (options.requiredQueryFields) {
    options.requiredQueryFields.forEach(function (fieldName) {
      if (!req.query[fieldName]) {
        throw new Error('Missing required field: ' + fieldName);
      }
      query[fieldName] = req.query[fieldName];
    });
  }

  // Constrain the query by each optional query field. Skip those for which
  // we got no value.
  if (options.optionalQueryFields) {
    options.optionalQueryFields.forEach(function (fieldName) {
      if (req.query[fieldName]) {
        query[fieldName] = req.query[fieldName];
      }
    });
  }

  return query;
}

function isArray(a) {
  return Object.prototype.toString.call(a) === '[object Array]'
}

function execQueryDecorators(decorators, query, req, res) {
  var decoType = typeof(decorators);

  if(decoType === 'function') {
    decorators = [decorators];
  }

  if(!isArray(decorators)) {
    throw "Decorator parameter is not an Array or String";
  }

  // TODO check lodash reduce syntax
  return _.reduce(decorators, function(fns, dec) {
    return dec(fns, req, res);
  }, query);
}

// FIXME should I be testing this directly?
exports.decoratorRunner = execQueryDecorators;

// Makes a result handler for mongo queries.
function makeResultHandler(request, response, options, mapperConfig) {
  mapperConfig = mapperConfig || {};

  function writeErr(err, code) {
    response.status(code);

    if(mapperConfig[code.toString()]) {
      if (mapperConfig[code.toString()].sendValue) {
        response.write(JSON.stringify(err));

      } else if(mapperConfig[code.toString()].sendValue === undefined) {
        log.warn('No configuration for', code, 'status code return value');
      }
    } else {
      log.warn('No configuration for', code, 'status codes');
    }

    response.end();
  }

  return function (error, results) {
    if (error) {

      if(mapperConfig.onError) {
        mapperConfig.onError(error, request, response);
        return;
      }

      if (error.name === 'ValidationError' || error.name === 'CastError') {
        writeErr(error, 400);
        return;
      }

      writeErr(error, 500);
    } else {
      if (options.postLoadProcessor) {
        results = options.postLoadProcessor(results, response);
      }

      // TODO investigate
      response.setHeader('Content-Type', 'text/plain');
      if (!_.isObject(results)) {
        // Do not wrap non-object results.
        response.status(200).send((results || '').toString());
        return;
      }

      if (!_.isArray(results)) {
        results = [results];
      }
      results = _.filter(results, function (result) {
        return options.filter(result, request);
      });

      if (options.useEnvelope) {
        results = _.map(results, function (result) {
          result = {
            meta: {
              can: {}
            },
            data: result
          };
          options.annotator(result, request);
          return result;
        });
      }

      response.status(200).send(results);
    }
  };
}

// Makes a getter function.
handlerFactories.get = function (options, mapperConfig) {
  return function (req, res) {
    var query = prepareQuery(req, options);
    execQueryDecorators(options.queryDecorator, query, req, res);
    
    var qb = options.actualModel.find(query);
    options.queryBuilder(qb, req, res);
    qb.lean().exec(makeResultHandler(req, res,
      options, mapperConfig));
  };
};

// Makes an updater function.
handlerFactories.put = function (options, mapperConfig) {
  return function (req, res) {
    var query = prepareQuery(req, options);
    options.queryDecorator(query, req, res);
    options.actualModel.findOne(query, function (err, object) {

      if (!object) {
        return res.status(404).send('Resource not found.');
      } else if (!options.filter(object, req)) {
        return res.status(401).send('Not allowed to PUT.');
      }

      _.keys(req.body).forEach(function (key) {
        if (key !== '_id' && key !== '__v') {
          object[key] = req.body[key];
        }
      });
      // We are using object.save() rather than findOneAndUpdate to ensure that
      // pre middleware is triggered.
      object.save(makeResultHandler(req, res, options, mapperConfig));
    });
  };
};

// Makes an poster function.
handlerFactories.post = function (options, mapperConfig) {
  return function (req, res) {
    var object = options.actualModel(req.body);
    if (!options.filter(object, req)) {
      return res.status(401).send('Not allowed to POST.');
    }
    if (!object) {
      return res.status(500).send('Failed to create an object.');
    }
    object.save(makeResultHandler(req, res, options, mapperConfig));
  };
};

// Makes an deleter function.
handlerFactories.delete = function (options, mapperConfig) {
  return function (req, res) {
    var query = prepareQuery(req, options);
    console.log(options.queryDecorator);
    options.queryDecorator(query, req, res);
    options.actualModel.remove(query,
      makeResultHandler(req, res, options, mapperConfig));
  };
};

// Makes a handler factory that will later create a handler based on provided
// configurations. This is to allow us to configure several methods for the
// same endpoint.
handlerFactories.auto = function (options, mapperConfig) {
  // We'll be returning a function that will take an endpoint configuration.
  // When this function is called and provided with the config, we'll look
  // into this config to figure out which handler factory to use and call it
  // with the original options.
  var factoryFunction = function (config) {
    var method = config.method;
    return handlerFactories[method](options, mapperConfig);
  };
  factoryFunction.isMiddlewareFactory = true;
  return factoryFunction;
};

/**
 * Creates a set of factories, which can then be used to create request
 * handlers.<br />
 * <b><em>TODO: document get, put, post, del</em></b>
 *
 * @param  {Object} dbConnection   A mongoose database connection (ot)
 * @return {Object}                An object offering handler factory methods.
 */
exports.makeMapper = function (dbConnection, config, loggerIn) {
  log = loggerIn;
  var service = {};

  dbConnection = dbConnection || dbUtils.getConnectionNow();

  service.options = {
    useEnvelope: true
  };
  service.options.queryDecorator = function () {}; // The default is to do nothing.
  service.options.filter = function () {
    // The default is to allow everything.
    return true;
  };
  service.options.annotator = function () {}; // The default is to do nothing.
  service.options.queryBuilder = function () {}; // The default is to do nothing.

  ['get', 'post', 'put', 'delete', 'auto'].forEach(function (method) {
    service[method] = function (arg) {
      var model;
      var handlerFactory;
      var options = {};
      var optionsSpecificToRoute;

      if (typeof arg === 'string') {
        optionsSpecificToRoute = {
          model: arg
        };
      } else {
        optionsSpecificToRoute = arg;
      }

      options = _.extend(options, service.options);
      options = _.extend(options, optionsSpecificToRoute);
      options.actualModel = dbConnection.model(options.model);
      handlerFactory = handlerFactories[method];

      return handlerFactory(options, config);
    };
  });

  return service;
};
