'use strict';

var _commander = require('commander');

var _commander2 = _interopRequireDefault(_commander);

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

var _path = require('path');

var _path2 = _interopRequireDefault(_path);

var _when = require('when');

var _when2 = _interopRequireDefault(_when);

var _ncp = require('ncp');

var _ncp2 = _interopRequireDefault(_ncp);

var _rimraf = require('rimraf');

var _rimraf2 = _interopRequireDefault(_rimraf);

var _through = require('through2');

var _through2 = _interopRequireDefault(_through);

var _spawned = require('spawned');

var _spawned2 = _interopRequireDefault(_spawned);

var _child_process = require('child_process');

var _child_process2 = _interopRequireDefault(_child_process);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _mkdirp = require('mkdirp');

var _mkdirp2 = _interopRequireDefault(_mkdirp);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var DESCRIPTOR_NAME = 'workspace.json'; // vim: noai:ts=2:sw=2

var npmMajorVersion = 0;
var self = module.exports = {};

var POSTINSTALL_SCRIPT = 'npm-workspace:install';

self.cli = function () {
  _commander2.default.version(require('../package.json').version).option('-c, --copy', 'Copy modules instead of linking').option('-v, --verbose', 'Output verbose log').option('-g, --remove-git', 'Remove .git directories during copy').option('-p, --production', 'Installs only dependencies (no devDependencies)').option('-r, --recursive', 'Follow all subdirectory paths for modules');

  _commander2.default.command('install').description('Install the package using local dirs').action(function () {
    try {
      npmMajorVersion = +_child_process2.default.execSync('npm -v', { encoding: 'utf8' }).split('.')[0];
    } catch (err) {
      console.log('[npm-workspace] Could not read npm version. Is npm in your path? ' + err);
    }

    self.install(process.cwd()).then(function () {
      console.log('[npm-workspace] Done, happy coding!');
    }).catch(function (err) {
      console.log(err.stack + '\n[npm-workspace] Ooooops, it wasn\'t my fault, I swear');
    });
  });

  _commander2.default.command('clean').description('Clean packages').action(function () {
    self.clean(process.cwd()).then(function () {
      console.log('[npm-workspace] Done, happy coding!');
    }).catch(function (err) {
      console.log(err.stack + '\n[npm-workspace] Ooooops, it wasn\'t my fault, I swear');
    });
  });

  _commander2.default.command('*').action(function () {
    _commander2.default.help();
  });

  _commander2.default.parse(process.argv);

  if (_commander2.default.args.length === 0) {
    _commander2.default.help();
  }
};

self.log = {
  verbose: function verbose(message) {
    if (_commander2.default.verbose) {
      console.log('[npm-workspace] ' + message);
    }
  },
  info: function info(message) {
    console.log('[npm-workspace] ' + message);
  },
  error: function error(message) {
    console.error('[npm-workspace] ' + message);
  },
  log: function log(message) {
    console.log(message);
  }
};

self.install = function (cwd, installedArg) {
  var installed = installedArg || [];

  var wsDesc = self.getWorkspaceDescriptor(cwd, true, true);
  var ret = _when2.default.resolve();
  if (wsDesc) {
    ret = self.installWorkspace(cwd, installed);
  }
  var pkg = self.getPackageDescriptor(cwd, true);
  if (pkg) {
    ret = (0, _when2.default)(ret, function () {
      return self.installModule(cwd, wsDesc, pkg, installed);
    });
  }

  return ret;
};

self.installWorkspace = function (cwd, installedArg) {
  self.log.info('Installing workspace ' + cwd);
  var installed = installedArg || [];

  var promise = _when2.default.resolve();
  var files = self.descendantsExcludingNpmModules(cwd, _commander2.default.recursive);
  _lodash2.default.each(files, function (file) {
    promise = promise.then(function () {
      return self.install(file, installed);
    });
  });
  return promise;
};

function onlyDirectories(f) {
  return _fs2.default.statSync(f).isDirectory();
}
function noDotFolders(f) {
  return _path2.default.basename(f).indexOf('.') !== 0;
}
function resolveTo(dir) {
  return function (file) {
    return _path2.default.resolve(dir, file);
  };
}
function flatten(arr) {
  return arr.reduce(function (flat, toFlatten) {
    return flat.concat(Array.isArray(toFlatten) ? flatten(toFlatten) : toFlatten);
  }, []);
}

self.descendantsExcludingNpmModules = function (cwd, recurse) {
  if (['node_modules', 'bower_components'].indexOf(_path2.default.basename(cwd)) > -1) {
    return [];
  } // skip very common package manager stores
  if (_path2.default.basename(cwd).indexOf('.') === 0) {
    return [];
  } // skip hidden directories

  var files = _fs2.default.readdirSync(cwd).map(resolveTo(cwd)).filter(onlyDirectories).filter(noDotFolders);
  if (files.length < 1) {
    return [];
  }
  if (recurse && files.length > 0) {
    _lodash2.default.each(files, function (file) {
      if (typeof file === 'string') {
        files.push(self.descendantsExcludingNpmModules(file, recurse));
      }
    });
  }
  return flatten(files); // flatten tree into simple list
};

/**
 * Fully install a single module (by linking modules if necessary)
 */
self.installModule = function (cwd, workspaceDescriptorIn, packageDescriptorIn, installed) {
  var workspaceDescriptor = workspaceDescriptorIn || self.getWorkspaceDescriptor(_path2.default.resolve(cwd, '../'));
  var packageDescriptor = packageDescriptorIn || self.getPackageDescriptor(cwd);
  var realDir = self.resolveLink(cwd);
  if (!_lodash2.default.contains(installed, realDir)) {
    installed.push(realDir);
  } else {
    self.log.verbose('Module already processed ' + realDir);
    return _when2.default.resolve();
  }

  self.ensureNodeModules(cwd);
  var nodeModulesDir = _path2.default.resolve(cwd, 'node_modules');

  var allDeps = _lodash2.default.extend({}, packageDescriptor.dependencies);
  if (!_commander2.default.production) {
    _lodash2.default.extend(allDeps, packageDescriptor.devDependencies);
  }

  self.log.verbose('Installing direct dependencies ' + JSON.stringify(_lodash2.default.keys(allDeps)) + ' for ' + packageDescriptor.name + '@' + packageDescriptor.version);

  return self.installWorkspaceDependencies(cwd, allDeps, workspaceDescriptor, installed).then(function () {
    // skip deep peer dependencies if doing a production install
    if (_commander2.default.production) {
      return;
    }

    // For the links we have to be sure we manually process the peerDependencies (recursively)
    // since they are not processed by npm
    // check peer dependencies for linked modules only
    function processLinked() {
      var deps = arguments.length <= 0 || arguments[0] === undefined ? _lodash2.default.pick(allDeps, _lodash2.default.keys(workspaceDescriptor.links)) : arguments[0];
      var processed = arguments.length <= 1 || arguments[1] === undefined ? _lodash2.default.clone(deps) : arguments[1];

      if (_lodash2.default.isEmpty(deps)) {
        return;
      }

      var newDeps = {};
      var promise = _when2.default.resolve();
      _lodash2.default.each(deps, function (version, link) {
        promise = promise.then(function () {
          var pkgPath = _path2.default.resolve(nodeModulesDir, link, 'package.json');
          if (!_fs2.default.existsSync(pkgPath)) {
            throw new Error('Invalid package at ' + pkgPath);
          }
          var linkPackage = require(pkgPath);

          if (!_lodash2.default.isEmpty(linkPackage.peerDependencies)) {
            // Install OR link peer dependencies
            self.log.verbose('Installing peer dependencies ' + JSON.stringify(_lodash2.default.keys(linkPackage.peerDependencies)) + ' from ' + linkPackage.name + '@' + linkPackage.version + ' into ' + cwd);
          }

          return self.installWorkspaceDependencies(cwd, linkPackage.peerDependencies, workspaceDescriptor, installed).then(function (newResults) {
            _lodash2.default.extend(newDeps, newResults.linked);
          });
        });
      });

      return promise.then(function () {
        var diff = _lodash2.default.omit(newDeps, _lodash2.default.keys(processed));
        // update the global list
        var newProcessed = _lodash2.default.extend({}, processed, diff);
        // process only new links
        return processLinked(diff, newProcessed);
      });
    }

    return processLinked();
  });
};

/**
 * Resolve a symbolic link if necessary
 */
self.resolveLink = function (dir) {
  if (_fs2.default.lstatSync(dir).isSymbolicLink()) {
    return _fs2.default.readlinkSync(dir);
  }
  return dir;
};

/**
 * Runs the npm-workspace post install script if present in the module's package
 */
self.postInstallModule = function (packageDescriptor, cwd) {
  if (!packageDescriptor.scripts || !packageDescriptor.scripts[POSTINSTALL_SCRIPT]) {
    return;
  }
  self.log.info('npm run ' + POSTINSTALL_SCRIPT + ' for ' + cwd);
  self.npm(['run', POSTINSTALL_SCRIPT], cwd);
};

/**
 * Launch the npm executable
 */
self.npm = function (argsIn, cwd) {
  var options = {
    cwd: cwd.replace(/\\/g, '/')
  };
  options.out = (0, _through2.default)(function (chunk, enc, cb) {
    if (_commander2.default.verbose) {
      undefined.push(chunk);
      process.stdout.write(chunk, enc, cb);
    }
  });
  options.err = (0, _through2.default)(function (chunk, enc, cb) {
    if (_commander2.default.verbose) {
      undefined.push(chunk);
      process.stdout.write(chunk, enc, cb);
    }
  });

  var args = argsIn;
  if (process.platform === 'win32') {
    args = [args.join(' ')]; // npm 2.x on Windows doesn't handle multiple argument properly?
  }

  return (0, _spawned2.default)('npm', args, options).catch(function (proc) {
    console.error(proc.combined);
  });
};

/**
 * Ensure node_modules exists
 */
self.ensureNodeModules = function (cwd) {
  var dir = _path2.default.resolve(cwd, 'node_modules');
  if (!_fs2.default.existsSync(dir)) {
    _mkdirp2.default.sync(dir);
  }
};

// splits each property of the dependencies object into its own object in an array
// i.e. {'a':1, 'b':2} becomes [{'name':'a','version':1},{'name':'b', 'version':2}]
function repack(obj) {
  var outp = [];
  Object.keys(obj || {}).forEach(function (k) {
    outp.push({ name: k, version: obj[k] });
  });
  return outp;
}

/**
 * Install (or link), in a specific module, a set of dependencies
 */
self.installWorkspaceDependencies = function (cwd, dependenciesIn, workspaceDescriptor, installed) {
  var dependencies = repack(dependenciesIn);
  var links = workspaceDescriptor.links || {};
  var repos = workspaceDescriptor.repos || {};
  var results = {
    linked: {},
    installed: {}
  };
  var nodeModulesDir = _path2.default.resolve(cwd, 'node_modules');

  // group dependencies by kind, and add some extra meta data.
  var linkDependencies = [];
  var specialRepoDeps = [];

  dependencies.forEach(function (spec) {
    var dest = _path2.default.resolve(nodeModulesDir, spec.name);
    if (links[spec.name]) {
      linkDependencies.push({ name: spec.name, version: spec.version, mapping: links[spec.name], dest: dest });
    } else if (repos[spec.name]) {
      specialRepoDeps.push({ name: spec.name, version: spec.version, altRepository: repos[spec.name], dest: dest });
    }
  });

  // To maintain compatibility with all npm versions up to 3, we do some odd things here
  // (1) add packages from special repos
  // (2) add dummy packages for anything that will be linked
  // (3) do a normal `npm i`
  // (4) remove the dummy packages and do the link/copy for real.

  var promise = _when2.default.resolve();
  var win = process.platform === 'win32';
  var q = win ? '"' : ''; // quote around version spec if running windows.

  // (1) add each of the special repo deps one-by-one
  specialRepoDeps.forEach(function (item) {
    promise = promise.then(function () {
      self.log.verbose('Installing single module ' + item.name + '@' + item.version + ' from ' + item.altRepository + ' for module ' + cwd);

      if (_fs2.default.existsSync(item.dest)) {
        return self.log.verbose('Already exists. Skipping ' + item.name);
      }

      var installArgs = ['install', item.name + '@' + q + item.version + q];
      installArgs.push('--registry');
      installArgs.push(item.altRepository);

      return self.npm(installArgs, cwd).then(function () {
        results.installed[item.name] = item.version;
      });
    });
  });

  // (2) add a dummy package for any links
  linkDependencies.forEach(function (item) {
    promise = promise.then(function () {
      self.log.verbose('Stubbing mapped module ' + item.name + '@' + item.version + ' for module ' + cwd);
      var exists = _fs2.default.existsSync(item.dest);
      var pkgIsSymLink = exists && _fs2.default.lstatSync(item.dest).isSymbolicLink();

      if (!exists || pkgIsSymLink) {
        if (pkgIsSymLink) {
          _rimraf2.default.sync(item.dest);
        }

        _mkdirp2.default.sync(item.dest);
        var realPkg = _path2.default.join(item.mapping, 'package.json');
        var stubPkg = _path2.default.join(item.dest, 'package.json');
        if (npmMajorVersion >= 3) {
          // make fake package in stub
          _fs2.default.writeFileSync(stubPkg, '{}', 'utf8');
        } else {
          // copy real package into stub (required for npm < 3)
          _fs2.default.writeFileSync(stubPkg, _fs2.default.readFileSync(realPkg), 'utf8');
        }
        _fs2.default.writeFileSync(_path2.default.join(item.dest, 'npm-workspace-stub'), '');
      }
    });
  });

  // (3) install all the normal packages
  promise = promise.then(function () {
    self.log.info('npm install for ' + cwd);

    var args = ['install'];
    if (_commander2.default.production) {
      args.push('--production');
    }

    var result = self.npm(args, cwd);
    self.postInstallModule(self.getPackageDescriptor(cwd), cwd);

    return result;
  });

  // (4) finally link modules and install sub-dependencies.
  linkDependencies.forEach(function (item) {
    promise = promise.then(function () {
      self.log.verbose('Processing mapped module ' + item.name + '@' + item.version + ' for module ' + cwd);
      var exists = _fs2.default.existsSync(item.dest);
      var pkgIsSymLink = exists && _fs2.default.lstatSync(item.dest).isSymbolicLink();

      // don't override by default
      if (_commander2.default.copy) {
        // remove any existing symlinks
        if (pkgIsSymLink) {
          _rimraf2.default.sync(item.dest);
        }

        // Check to see if this is a stub package. If so, delete and continue with the copy
        var stubMarker = _path2.default.join(item.dest, 'npm-workspace-stub');
        if (exists && _fs2.default.existsSync(stubMarker)) {
          _rimraf2.default.sync(item.dest);
        }

        // copy if not already present
        if (!_fs2.default.existsSync(item.dest)) {
          self.log.info('Copying ' + item.dest + ' from ' + item.mapping);
          var copy = _when2.default.promise(function (resolve, reject) {
            (0, _ncp2.default)(item.mapping, item.dest, function (err) {
              if (err) {
                return reject(err);
              }
              // remove .git if options say so
              if (_commander2.default.removeGit) {
                self.log.info('Cleaning .git directory ' + _path2.default.join(item.dest, '.git'));
                _rimraf2.default.sync(_path2.default.join(item.dest, '.git'));
                _rimraf2.default.sync(_path2.default.join(item.dest, '.gitignore'));
              }
              resolve();
            });
          });
          return copy;
        }
      } else if ( /* not a copy, and */!pkgIsSymLink) {
        _rimraf2.default.sync(item.dest); // remove dummy package

        _fs2.default.symlinkSync(item.mapping, item.dest, 'dir');
        self.log.info('Created link ' + item.dest + ' -> ' + item.mapping);

        self.postInstallModule(self.getPackageDescriptor(item.mapping), item.mapping);
      }

      // now we make sure we fully install this linked module
    }).then(function () {
      return self.install(item.dest, installed); // Future : only do this if we haven't seen it
      // before
    }).then(function () {
      results.linked[item.name] = item.version;
    });
  });

  // All install promises hooked up, return them to be run
  return promise.then(function () {
    return results;
  });
};

self.isRoot = function (root) {
  return _path2.default.resolve('/') === _path2.default.resolve(root);
};

self.normalizeDescriptor = function (cwd, descriptorIn) {
  var descriptor = _lodash2.default.cloneDeep(descriptorIn);

  // resolve dirs for the the 'link' property
  var newLinks = {};
  _lodash2.default.each(descriptor.links, function (dir, modName) {
    newLinks[modName] = _path2.default.resolve(cwd, dir);
  });
  descriptor.links = newLinks;

  return descriptor;
};

// read the 'package.json' file in the current directory
self.getPackageDescriptor = function (cwd, nothrow) {
  var fileDesc = _path2.default.resolve(cwd, 'package.json');
  if (_fs2.default.existsSync(fileDesc)) {
    return require(fileDesc);
  }

  if (!nothrow) {
    throw new Error('Cannot find package.json');
  }
  // don't go upper (for now)
  return null;
};

// recurse up from current location to find 'workspace.json'
self.getWorkspaceDescriptor = function (cwd, shallow, nothrow) {
  var fileDesc = _path2.default.resolve(cwd, DESCRIPTOR_NAME);
  if (_fs2.default.existsSync(fileDesc)) {
    return self.normalizeDescriptor(cwd, require(fileDesc));
  } else if (shallow || self.isRoot(cwd)) {
    if (nothrow) {
      return null;
    }
    throw new Error('Cannot find workspace.json');
  }

  return self.getWorkspaceDescriptor(_path2.default.resolve(cwd, '../'), shallow, nothrow);
};

self.clean = function (cwd) {
  var wsDesc = self.getWorkspaceDescriptor(cwd, true, true);
  var ret = _when2.default.resolve();
  if (wsDesc) {
    // we are in a workspace
    ret = _when2.default.resolve(self.cleanWorkspace(cwd));
  }

  var pkg = self.getPackageDescriptor(cwd, true);
  if (pkg) {
    // we are in a module dir
    ret = (0, _when2.default)(ret, function () {
      return self.cleanModule(cwd);
    });
  }

  return ret;
};

function longestFirst(a, b) {
  return b.length - a.length;
}

self.cleanWorkspace = function (cwd) {
  // let's be sure we are in a workspace
  if (!self.getWorkspaceDescriptor(cwd, true, true)) {
    return;
  }
  self.log.info('Cleaning workspace ' + cwd);

  var files = self.descendantsExcludingNpmModules(cwd, _commander2.default.recursive);
  files.sort(longestFirst); // less likely to break symlinks on Windows.

  _lodash2.default.each(files, function (file) {
    self.cleanModule(file);
  });
};

self.cleanModule = function (cwd) {
  // let's be sure we are in a module
  if (!self.getPackageDescriptor(cwd, true)) {
    return;
  }
  self.log.info('Cleaning module ' + cwd);
  _rimraf2.default.sync(_path2.default.resolve(cwd, 'node_modules'));
};

//# sourceMappingURL=npm-workspace.js.map