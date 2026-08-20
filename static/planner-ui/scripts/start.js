'use strict';

// `react-scripts start` shim for webpack-dev-server v5.
//
// react-scripts@5.0.1 is EOL and still builds a webpack-dev-server v4 options
// object (`https`, `onBeforeSetupMiddleware`, `onAfterSetupMiddleware`). v5
// removed all three and validates with `additionalProperties: false`, so the
// unpatched config throws "Invalid options object" against the v5 we pin in
// `overrides` to clear the dev-server advisories.
//
// This translates the config to the v5 shape, then hands off to the real
// `react-scripts/scripts/start.js`. Everything else (port picking, compiler
// messages, browser opening) stays CRA's.

const path = require('path');
const fs = require('fs');

const reactScriptsDir = path.dirname(
  require.resolve('react-scripts/package.json')
);

// react-dev-utils is react-scripts' dependency, not ours — resolve from there.
const fromReactScripts = id =>
  require(require.resolve(id, { paths: [reactScriptsDir] }));

const evalSourceMapMiddleware = fromReactScripts(
  'react-dev-utils/evalSourceMapMiddleware'
);
const noopServiceWorkerMiddleware = fromReactScripts(
  'react-dev-utils/noopServiceWorkerMiddleware'
);
const redirectServedPath = fromReactScripts(
  'react-dev-utils/redirectServedPathMiddleware'
);
const paths = require('react-scripts/config/paths');

// v5 dropped `close()` in favour of `stop()`/`stopCallback()`, but CRA's
// SIGINT/SIGTERM handlers still call it. Without this, Ctrl-C crashes with
// "devServer.close is not a function".
const WebpackDevServer = require('webpack-dev-server');
if (typeof WebpackDevServer.prototype.close !== 'function') {
  WebpackDevServer.prototype.close = function close(callback) {
    return this.stopCallback(callback || (() => {}));
  };
}

const configPath = require.resolve('react-scripts/config/webpackDevServer.config');
const createDevServerConfig = require(configPath);

// Replace the cached export so CRA's start.js gets the translated config.
require.cache[configPath].exports = function (proxy, allowedHost) {
  const {
    https,
    onBeforeSetupMiddleware,
    onAfterSetupMiddleware,
    ...config
  } = createDevServerConfig(proxy, allowedHost);

  // `https: true | { key, cert, ... }` -> `server: { type, options }`
  if (https) {
    config.server = {
      type: 'https',
      ...(typeof https === 'object' ? { options: https } : {}),
    };
  }

  // `onBeforeSetupMiddleware` / `onAfterSetupMiddleware` -> `setupMiddlewares`.
  // `unshift`/`push` preserve v4 ordering: the source-map middleware runs
  // before CRA's internal middlewares, the redirect and no-op service worker
  // after them.
  config.setupMiddlewares = (middlewares, devServer) => {
    // `evalSourceMapMiddleware` (used by the error overlay to resolve
    // `webpack-internal:///` sources) reads the v4 private field
    // `server._stats`, which v5 renamed to `server.stats`. Without this alias
    // every `/__get-internal-source` request throws.
    if (devServer._stats === undefined) {
      Object.defineProperty(devServer, '_stats', {
        get() {
          return this.stats;
        },
      });
    }

    middlewares.unshift({
      name: 'evaluated-source-map',
      middleware: evalSourceMapMiddleware(devServer),
    });

    if (fs.existsSync(paths.proxySetup)) {
      require(paths.proxySetup)(devServer.app);
    }

    middlewares.push(
      {
        name: 'redirect-served-path',
        middleware: redirectServedPath(paths.publicUrlOrPath),
      },
      {
        name: 'noop-service-worker',
        middleware: noopServiceWorkerMiddleware(paths.publicUrlOrPath),
      }
    );

    return middlewares;
  };

  return config;
};

require('react-scripts/scripts/start.js');
