'use strict';

var coreHttpModule = require('http');
var coreHttpsModule = require('https');

var semver = require('semver');
var URL = require('url').URL;

var tracingUtil = require('../../tracingUtil');
var urlUtil = require('../../../util/url');
var httpCommon = require('./_http');
var constants = require('../../constants');
var cls = require('../../cls');
var url = require('url');

var discardUrlParameters = urlUtil.discardUrlParameters;
var filterParams = urlUtil.filterParams;

var extraHttpHeadersToCapture;
var isActive = false;

exports.init = function(config) {
  instrument(coreHttpModule);

  // Up until Node 8, the core https module uses the http module internally, so https calls are traced automatically
  // without instrumenting https. Beginning with Node 9, the core https module started to use the internal core module
  // _http_client directly rather than going through the http module. Therefore, beginning with Node 9, explicit
  // instrumentation of the core https module is required. OTOH, in Node <= 8, we must _not_ instrument https, as
  // otherwise we would run our instrumentation code twice (once for https.request and once for http.request).
  // In case you wonder about the process.versions.node === '8.9.0' and if it shouldn't rather be something like
  // semver.gte(process.version.node, '8.9.0') – no, it should not. Node had backported the refactoring to use
  // _http_client directly in https (instead of going through http) from Node.js 9.0.0 to Node.js 8.9.0, only to revert
  // that immediately in Node.js 8.9.1 a few days later. So we must only apply this for exactly 8.9.0, but for no other
  // 8.x.x version.
  if (semver.gte(process.versions.node, '9.0.0') || process.versions.node === '8.9.0') {
    instrument(coreHttpsModule);
  }
  extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture;
};

exports.updateConfig = function(config) {
  extraHttpHeadersToCapture = config.tracing.http.extraHttpHeadersToCapture;
};

function instrument(coreModule) {
  var originalRequest = coreModule.request;
  coreModule.request = function request() {
    var clientRequest;

    // When http.request is called with http.request(options, undefined) (happens with request-promise, for example),
    // arguments.length will still be 2 but there is no callback. Even though we push a callback into the arguments
    // array, this cb will then be at index 2, thus never get called in older versions of Node, hence the span would
    // not be finished/transmitted. We normalize the args by removing undefined/null from the end.
    while (arguments.length > 0 && arguments[arguments.length - 1] == null) {
      arguments.length--;
    }
    var originalArgs = new Array(arguments.length);
    for (var i = 0; i < arguments.length; i++) {
      originalArgs[i] = arguments[i];
    }

    var urlArg = null;
    var options = null;
    var callback = null;
    var callbackIndex = -1;

    if (typeof originalArgs[0] === 'string' || isUrlObject(originalArgs[0])) {
      urlArg = originalArgs[0];
    } else if (typeof originalArgs[0] === 'object') {
      options = originalArgs[0];
    }
    if (!options && typeof originalArgs[1] === 'object') {
      options = originalArgs[1];
    }
    if (typeof originalArgs[1] === 'function') {
      callback = originalArgs[1];
      callbackIndex = 1;
    }
    if (!callback && typeof originalArgs[2] === 'function') {
      callback = originalArgs[2];
      callbackIndex = 2;
    }

    var w3cTraceContext = cls.getW3cTraceContext();
    var parentSpan = cls.getCurrentSpan() || cls.getReducedSpan();

    if (!isActive || !parentSpan || constants.isExitSpan(parentSpan)) {
      var traceLevelHeaderHasBeenAdded = false;
      if (cls.tracingSuppressed()) {
        traceLevelHeaderHasBeenAdded = tryToAddTraceLevelAddHeaderToOpts(options, '0', w3cTraceContext);
      }
      clientRequest = originalRequest.apply(coreModule, arguments);
      if (cls.tracingSuppressed() && !traceLevelHeaderHasBeenAdded) {
        clientRequest.setHeader(constants.traceLevelHeaderName, '0');
        setW3cHeadersOnRequest(clientRequest, w3cTraceContext);
      }
      return clientRequest;
    }

    cls.ns.run(function() {
      var span = cls.startSpan('node.http.client', constants.EXIT);

      // startSpan updates the W3C trace context and writes it back to CLS, so we have to refetch the updated context
      // object from CLS.
      w3cTraceContext = cls.getW3cTraceContext();

      var completeCallUrl;
      var params;
      if (urlArg && typeof urlArg === 'string') {
        // just one string....
        completeCallUrl = discardUrlParameters(urlArg);
        params = splitAndFilter(urlArg);
      } else if (urlArg && isUrlObject(urlArg)) {
        completeCallUrl = discardUrlParameters(url.format(urlArg));
        params = dropLeadingQuestionMark(filterParams(urlArg.search));
      } else if (options) {
        var urlAndQuery = constructFromUrlOpts(options, coreModule);
        completeCallUrl = urlAndQuery[0];
        params = urlAndQuery[1];
      }

      span.stack = tracingUtil.getStackTrace(request);

      var boundCallback = cls.ns.bind(function boundCallback(res) {
        span.data.http = {
          method: clientRequest.method,
          url: completeCallUrl,
          status: res.statusCode,
          params: params
        };
        var headers = captureRequestHeaders(options, clientRequest, res);

        if (headers) {
          span.data.http.header = headers;
        }
        span.d = Date.now() - span.ts;
        span.ec = res.statusCode >= 500 ? 1 : 0;
        span.transmit();

        if (callback) {
          callback(res);
        }
      });

      if (callbackIndex >= 0) {
        originalArgs[callbackIndex] = boundCallback;
      } else {
        originalArgs.push(boundCallback);
      }

      try {
        var instanaHeadersHaveBeenAdded = tryToAddHeadersToOpts(options, span, w3cTraceContext);
        clientRequest = originalRequest.apply(coreModule, originalArgs);
      } catch (e) {
        // A synchronous exception indicates a failure that is not covered by the listeners. Using a malformed URL for
        // example is a case that triggers a synchronous exception.
        span.data.http = {
          url: completeCallUrl,
          error: e ? e.message : ''
        };
        span.d = Date.now() - span.ts;
        span.ec = 1;
        span.transmit();
        throw e;
      }

      cls.ns.bindEmitter(clientRequest);
      if (!instanaHeadersHaveBeenAdded) {
        instanaHeadersHaveBeenAdded = setHeadersOnRequest(clientRequest, span, w3cTraceContext);
      }

      var isTimeout = false;
      clientRequest.on('timeout', function() {
        // From the Node.js HTTP client documentation:
        //
        //  > Emitted when the underlying socket times out from inactivity. This **only notifies** that the socket
        //  > has been idle. **The request must be aborted manually.**
        //
        // This means that the timeout event is only an indication that something is wrong. After the timeout occurred,
        // a well behaved client will do one of two things:
        //
        // 1) Abort the request via req.abort(). This will result in a "socket hang up" error event being emitted by
        //    the request.
        // 2) The request continues as normal and the timeout is ignored. In this case, we could end up either in a
        //    success or in an error state. This is most likely unintentional HTTP client behavior.
        //
        // On top of this, commonly used HTTP client libraries add additional timeout capabilities based on wall clock
        // time on top of Node.js' timeout capabilities (which typically end in an abort() call).
        isTimeout = true;
      });

      clientRequest.on('error', function(err) {
        var errorMessage = err.message;
        if (isTimeout) {
          errorMessage = 'Timeout exceeded';

          if (clientRequest.aborted) {
            errorMessage += ', request aborted';
          }
        } else if (clientRequest.aborted) {
          errorMessage = 'Request aborted';
        }
        span.data.http = {
          method: clientRequest.method,
          url: completeCallUrl,
          error: errorMessage
        };
        span.d = Date.now() - span.ts;
        span.ec = 1;
        span.transmit();
      });
    });
    return clientRequest;
  };

  coreModule.get = function get() {
    var req = coreModule.request.apply(coreModule, arguments);
    req.end();
    return req;
  };
}

exports.activate = function() {
  isActive = true;
};

exports.deactivate = function() {
  isActive = false;
};

exports.setExtraHttpHeadersToCapture = function setExtraHttpHeadersToCapture(_extraHeaders) {
  extraHttpHeadersToCapture = _extraHeaders;
};

function constructFromUrlOpts(options, self) {
  if (options.href) {
    return [discardUrlParameters(options.href), splitAndFilter(options.href)];
  }

  try {
    var agent = options.agent || self.agent;
    var port = options.port || options.defaultPort || (agent && agent.defaultPort) || 80;
    var protocol = (port === 443 && 'https:') || options.protocol || (agent && agent.protocol) || 'http:';
    var host = options.hostname || options.host || 'localhost';
    var path = options.path || '/';
    return [discardUrlParameters(protocol + '//' + host + ':' + port + path), splitAndFilter(path)];
  } catch (e) {
    return [undefined, undefined];
  }
}

function isUrlObject(argument) {
  return URL && argument instanceof url.URL;
}

function tryToAddHeadersToOpts(options, span, w3cTraceContext) {
  // Some HTTP spec background: If the request has a header Expect: 100-continue, the client will first send the
  // request headers, without the body. The client is then ought to wait for the server to send a first, preliminary
  // response with the status code 100 Continue (if all is well). Only then will the client send the actual request
  // body.

  // The Node.js HTTP client core module implements this in the following way: If the option's object given to the
  // `http(s).request` contains "Expect": "100-continue", it will immediately flush the headers and send them internally
  // via `send(''). That is, when `http.request(...)` returns, the headers have already been sent and can no longer be
  // modified. The client code is expected to not call `request.setHeaders` on that request. Usually the client code
  // will listen for the request to emit the 'continue' event (signalling that the server has sent "100 Continue") and
  // only then write the response body to the request, for example by calling `request.end(body)`.

  // Thus, at the very least, when this header is present in the incoming request options arguments, we need to add our
  // INSTANA-... HTTP headers to options.headers instead of calling request.setHeader later. In fact, we opt for the
  // slightly more general solution: If there is an options object parameter with a `headers` object, we just always
  // add our headers there. We use request.setHeader on the ClientRequest object only when the headers object is missing
  // (see setHeadersOnRequest).

  if (hasHeadersOption(options)) {
    if (!isItSafeToModifiyHeadersInOptions(options)) {
      return true;
    }
    options.headers[constants.spanIdHeaderName] = span.s;
    options.headers[constants.traceIdHeaderName] = span.t;
    options.headers[constants.traceLevelHeaderName] = '1';
    tryToAddW3cHeaderToOpts(options, w3cTraceContext);
    return true;
  }

  return false;
}

function tryToAddTraceLevelAddHeaderToOpts(options, level, w3cTraceContext) {
  if (hasHeadersOption(options)) {
    if (!isItSafeToModifiyHeadersInOptions(options)) {
      return true;
    }
    options.headers[constants.traceLevelHeaderName] = level;
    tryToAddW3cHeaderToOpts(options, w3cTraceContext);
    return true;
  }
  return false;
}

function tryToAddW3cHeaderToOpts(options, w3cTraceContext) {
  if (w3cTraceContext) {
    options.headers[constants.w3cTraceParent] = w3cTraceContext.renderTraceParent();
    if (w3cTraceContext.hasTraceState()) {
      options.headers[constants.w3cTraceState] = w3cTraceContext.renderTraceState();
    }
  }
}

function hasHeadersOption(options) {
  return options && typeof options === 'object' && options.headers && typeof options.headers === 'object';
}

function setHeadersOnRequest(clientRequest, span, w3cTraceContext) {
  if (!isItSafeToModifiyHeadersForRequest(clientRequest)) {
    return;
  }
  clientRequest.setHeader(constants.spanIdHeaderName, span.s);
  clientRequest.setHeader(constants.traceIdHeaderName, span.t);
  clientRequest.setHeader(constants.traceLevelHeaderName, '1');
  setW3cHeadersOnRequest(clientRequest, w3cTraceContext);
}

function setW3cHeadersOnRequest(clientRequest, w3cTraceContext) {
  if (w3cTraceContext) {
    clientRequest.setHeader(constants.w3cTraceParent, w3cTraceContext.renderTraceParent());
    if (w3cTraceContext.hasTraceState()) {
      clientRequest.setHeader(constants.w3cTraceState, w3cTraceContext.renderTraceState());
    }
  }
}

function isItSafeToModifiyHeadersInOptions(options) {
  var keys = Object.keys(options.headers);
  var key;
  for (var i = 0; i < keys.length; i++) {
    key = keys[i];
    if (
      'authorization' === key.toLowerCase() &&
      typeof options.headers[key] === 'string' &&
      options.headers[key].indexOf('AWS') === 0
    ) {
      // This is a signed AWS API request (probably from the aws-sdk package).
      // Adding our headers too this request would trigger a SignatureDoesNotMatch error in case the request will be
      // retried:
      // "SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.
      // Check your key and signing method."
      // See https://docs.aws.amazon.com/general/latest/gr/signing_aws_api_requests.html
      //
      // Additionally, adding our headers to this request would not have any benefit - the receiving end will be an AWS
      // service like S3 and those are not instrumented. (There is a very small chance that the receiving end is an
      // instrumented Lambda function behind an API gateway and the user is using
      // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/APIGateway.html to invoke this Gateway/Lambda
      // combination, which _would_ benefit from tracing headers.)
      return false;
    }
  }
  return true;
}

function isItSafeToModifiyHeadersForRequest(clientRequest) {
  var authHeader = clientRequest.getHeader('Authorization');
  // see comment in isItSafeToModifiyHeadersInOptions
  return !authHeader || authHeader.indexOf('AWS') !== 0;
}

function splitAndFilter(fullUrl) {
  var parts = fullUrl.split('?');
  if (parts.length >= 1) {
    return filterParams(parts[1]);
  }
  return null;
}

function dropLeadingQuestionMark(params) {
  if (params && params.charAt(0) === '?') {
    return params.substring(1);
  }
  return params;
}

function captureRequestHeaders(options, clientRequest, response) {
  var headers = httpCommon.getExtraHeadersCaseInsensitive(options, extraHttpHeadersToCapture);
  headers = httpCommon.mergeExtraHeadersFromServerResponseOrClientResponse(
    headers,
    clientRequest,
    extraHttpHeadersToCapture
  );
  headers = httpCommon.mergeExtraHeadersFromIncomingMessage(headers, response, extraHttpHeadersToCapture);
  return headers;
}
