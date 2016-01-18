// vim: noai:ts=2:sw=2
import program from 'commander';
import fs from 'fs';
import path from 'path';
import when from 'when';
import ncp from 'ncp';
import rimraf from 'rimraf';
import through2 from 'through2';
import spawned from 'spawned';
import childProcess from 'child_process';
import _ from 'lodash';
import mkdirp from 'mkdirp';

const DESCRIPTOR_NAME = 'workspace.json';

let npmMajorVersion = 0;
const self = module.exports = {};

const POSTINSTALL_SCRIPT = 'npm-workspace:install';

self.cli = () => {
  program
    .version(require('../package.json').version)
    .option('-c, --copy', 'Copy modules instead of linking')
    .option('-v, --verbose', 'Output verbose log')
    .option('-g, --remove-git', 'Remove .git directories during copy')
    .option('-p, --production', 'Installs only dependencies (no devDependencies)')
    .option('-r, --recursive', 'Follow all subdirectory paths for modules');

  program
    .command('install')
    .description('Install the package using local dirs')
    .action(() => {
      try {
        npmMajorVersion = +childProcess.execSync('npm -v', { encoding: 'utf8' }).split('.')[0];
      } catch (err) {
        console.log('[npm-workspace] Could not read npm version. Is npm in your path? ' + err);
      }

      self.install(process.cwd()).then(() => {
        console.log('[npm-workspace] Done, happy coding!');
      }).catch((err) => {
        console.log(err.stack + '\n[npm-workspace] Ooooops, it wasn\'t my fault, I swear');
      });
    });

  program
    .command('clean')
    .description('Clean packages')
    .action(() => {
      self.clean(process.cwd()).then(() => {
        console.log('[npm-workspace] Done, happy coding!');
      }).catch((err) => {
        console.log(err.stack + '\n[npm-workspace] Ooooops, it wasn\'t my fault, I swear');
      });
    });

  program
    .command('*')
    .action(() => {
      program.help();
    });

  program.parse(process.argv);


  if (program.args.length === 0) {
    program.help();
  }
};


self.log = {
  verbose(message) {
    if (program.verbose) {
      console.log('[npm-workspace] ' + message);
    }
  },
  info(message) {
    console.log('[npm-workspace] ' + message);
  },
  error(message) {
    console.error('[npm-workspace] ' + message);
  },
  log(message) {
    console.log(message);
  }
};

self.install = (cwd, installedArg) => {
  const installed = installedArg || [];

  const wsDesc = self.getWorkspaceDescriptor(cwd, true, true);
  let ret = when.resolve();
  if (wsDesc) {
    ret = self.installWorkspace(cwd, installed);
  }
  const pkg = self.getPackageDescriptor(cwd, true);
  if (pkg) {
    ret = when(ret, () => {
      return self.installModule(cwd, wsDesc, pkg, installed);
    });
  }

  return ret;
};


self.installWorkspace = (cwd, installedArg) => {
  self.log.info('Installing workspace ' + cwd);
  const installed = installedArg || [];

  let promise = when.resolve();
  const files = self.descendantsExcludingNpmModules(cwd, program.recursive);
  _.each(files, (file) => {
    promise = promise.then(() => {
      return self.install(file, installed);
    });
  });
  return promise;
};

function onlyDirectories(f) {
  return fs.statSync(f).isDirectory();
}
function noDotFolders(f) {
  return path.basename(f).indexOf('.') !== 0;
}
function resolveTo(dir) {
  return (file) => {
    return path.resolve(dir, file);
  };
}
function flatten(arr) {
  return arr.reduce((flat, toFlatten) => {
    return flat.concat(Array.isArray(toFlatten) ? flatten(toFlatten) : toFlatten);
  }, []);
}

self.descendantsExcludingNpmModules = (cwd, recurse) => {
  if (['node_modules', 'bower_components'].indexOf(path.basename(cwd)) > -1) {
    return [];
  } // skip very common package manager stores
  if (path.basename(cwd).indexOf('.') === 0) {
    return [];
  } // skip hidden directories

  const files = fs.readdirSync(cwd)
    .map(resolveTo(cwd))
    .filter(onlyDirectories)
    .filter(noDotFolders);
  if (files.length < 1) {
    return [];
  }
  if (recurse && files.length > 0) {
    _.each(files, (file) => {
      if (typeof (file) === 'string') {
        files.push(self.descendantsExcludingNpmModules(file, recurse));
      }
    });
  }
  return flatten(files); // flatten tree into simple list
};


/**
 * Fully install a single module (by linking modules if necessary)
 */
self.installModule = (cwd,
                      workspaceDescriptorIn,
                      packageDescriptorIn,
                      installed) => {
  const workspaceDescriptor = workspaceDescriptorIn || self.getWorkspaceDescriptor(path.resolve(cwd, '../'));
  const packageDescriptor = packageDescriptorIn || self.getPackageDescriptor(cwd);
  const realDir = self.resolveLink(cwd);
  if (!_.contains(installed, realDir)) {
    installed.push(realDir);
  } else {
    self.log.verbose('Module already processed ' + realDir);
    return when.resolve();
  }

  self.ensureNodeModules(cwd);
  const nodeModulesDir = path.resolve(cwd, 'node_modules');

  const allDeps = _.extend({}, packageDescriptor.dependencies);
  if (!program.production) {
    _.extend(allDeps, packageDescriptor.devDependencies);
  }

  self.log.verbose('Installing direct dependencies ' + JSON.stringify(_.keys(allDeps)) + ' for '
    + packageDescriptor.name + '@' + packageDescriptor.version);

  return self.installWorkspaceDependencies(cwd, allDeps, workspaceDescriptor, installed)
    .then(() => {
      // skip deep peer dependencies if doing a production install
      if (program.production) {
        return;
      }

      // For the links we have to be sure we manually process the peerDependencies (recursively)
      // since they are not processed by npm
      // check peer dependencies for linked modules only
      function processLinked(deps = _.pick(allDeps, _.keys(workspaceDescriptor.links)),
                             processed = _.clone(deps)) {
        if (_.isEmpty(deps)) {
          return;
        }

        const newDeps = {};
        let promise = when.resolve();
        _.each(deps, (version, link) => {
          promise = promise.then(() => {
            const pkgPath = path.resolve(nodeModulesDir, link, 'package.json');
            if (!fs.existsSync(pkgPath)) {
              throw new Error('Invalid package at ' + pkgPath);
            }
            const linkPackage = require(pkgPath);

            if (!_.isEmpty(linkPackage.peerDependencies)) {
              // Install OR link peer dependencies
              self.log.verbose('Installing peer dependencies ' +
                JSON.stringify(_.keys(linkPackage.peerDependencies)) + ' from '
                + linkPackage.name + '@' + linkPackage.version + ' into ' + cwd);
            }

            return self.installWorkspaceDependencies(cwd, linkPackage.peerDependencies,
              workspaceDescriptor, installed)
              .then((newResults) => {
                _.extend(newDeps, newResults.linked);
              });
          });
        });

        return promise.then(() => {
          const diff = _.omit(newDeps, _.keys(processed));
          // update the global list
          const newProcessed = _.extend({}, processed, diff);
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
self.resolveLink = (dir) => {
  if (fs.lstatSync(dir).isSymbolicLink()) {
    return fs.readlinkSync(dir);
  }
  return dir;
};

/**
 * Runs the npm-workspace post install script if present in the module's package
 */
self.postInstallModule = (packageDescriptor, cwd) => {
  if (!packageDescriptor.scripts || !packageDescriptor.scripts[POSTINSTALL_SCRIPT]) {
    return;
  }
  self.log.info('npm run ' + POSTINSTALL_SCRIPT + ' for ' + cwd);
  self.npm(['run', POSTINSTALL_SCRIPT], cwd);
};

/**
 * Launch the npm executable
 */
self.npm = (argsIn, cwd) => {
  const options = {
    cwd: cwd.replace(/\\/g, '/')
  };
  options.out = through2((chunk, enc, cb) => {
    if (program.verbose) {
      this.push(chunk);
      process.stdout.write(chunk, enc, cb);
    }
  });
  options.err = through2((chunk, enc, cb) => {
    if (program.verbose) {
      this.push(chunk);
      process.stdout.write(chunk, enc, cb);
    }
  });

  let args = argsIn;
  if (process.platform === 'win32') {
    args = [(args.join(' '))]; // npm 2.x on Windows doesn't handle multiple argument properly?
  }

  return spawned('npm', args, options)
    .catch((proc) => {
      console.error(proc.combined);
    });
};


/**
 * Ensure node_modules exists
 */
self.ensureNodeModules = (cwd) => {
  const dir = path.resolve(cwd, 'node_modules');
  if (!fs.existsSync(dir)) {
    mkdirp.sync(dir);
  }
};

// splits each property of the dependencies object into its own object in an array
// i.e. {'a':1, 'b':2} becomes [{'name':'a','version':1},{'name':'b', 'version':2}]
function repack(obj) {
  const outp = [];
  Object.keys(obj || {}).forEach((k) => {
    outp.push({ name: k, version: obj[k] });
  });
  return outp;
}


/**
 * Install (or link), in a specific module, a set of dependencies
 */
self.installWorkspaceDependencies = (cwd, dependenciesIn, workspaceDescriptor, installed) => {
  const dependencies = repack(dependenciesIn);
  const links = workspaceDescriptor.links || {};
  const repos = workspaceDescriptor.repos || {};
  const results = {
    linked: {},
    installed: {}
  };
  const nodeModulesDir = path.resolve(cwd, 'node_modules');

  // group dependencies by kind, and add some extra meta data.
  const linkDependencies = [];
  const specialRepoDeps = [];

  dependencies.forEach((spec) => {
    const dest = path.resolve(nodeModulesDir, spec.name);
    if (links[spec.name]) {
      linkDependencies.push(
        { name: spec.name, version: spec.version, mapping: links[spec.name], dest });
    } else if (repos[spec.name]) {
      specialRepoDeps.push(
        { name: spec.name, version: spec.version, altRepository: repos[spec.name], dest });
    }
  });

  // To maintain compatibility with all npm versions up to 3, we do some odd things here
  // (1) add packages from special repos
  // (2) add dummy packages for anything that will be linked
  // (3) do a normal `npm i`
  // (4) remove the dummy packages and do the link/copy for real.

  let promise = when.resolve();
  const win = process.platform === 'win32';
  const q = (win) ? ('"') : (''); // quote around version spec if running windows.

  // (1) add each of the special repo deps one-by-one
  specialRepoDeps.forEach((item) => {
    promise = promise.then(() => {
      self.log.verbose('Installing single module ' + item.name +
        '@' + item.version + ' from ' + item.altRepository + ' for module ' + cwd);

      if (fs.existsSync(item.dest)) {
        return self.log.verbose(
          'Already exists. Skipping ' + item.name);
      }

      const installArgs = ['install', item.name + '@' + q + item.version + q];
      installArgs.push('--registry');
      installArgs.push(item.altRepository);

      return self.npm(installArgs, cwd).then(() => {
        results.installed[item.name] = item.version;
      });
    });
  });

  // (2) add a dummy package for any links
  linkDependencies.forEach((item) => {
    promise = promise.then(() => {
      self.log.verbose(
        'Stubbing mapped module ' + item.name + '@' + item.version + ' for module ' + cwd);
      const exists = fs.existsSync(item.dest);
      const pkgIsSymLink = exists && fs.lstatSync(item.dest).isSymbolicLink();

      if (!exists || pkgIsSymLink) {
        if (pkgIsSymLink) {
          rimraf.sync(item.dest);
        }

        mkdirp.sync(item.dest);
        const realPkg = path.join(item.mapping, 'package.json');
        const stubPkg = path.join(item.dest, 'package.json');
        if (npmMajorVersion >= 3) {// make fake package in stub
          fs.writeFileSync(stubPkg, '{}', 'utf8');
        } else {// copy real package into stub (required for npm < 3)
          fs.writeFileSync(stubPkg, fs.readFileSync(realPkg), 'utf8');
        }
        fs.writeFileSync(path.join(item.dest, 'npm-workspace-stub'), '');
      }
    });
  });


  // (3) install all the normal packages
  promise = promise.then(() => {
    self.log.info('npm install for ' + cwd);

    const args = ['install'];
    if (program.production) {
      args.push('--production');
    }

    const result = self.npm(args, cwd);
    self.postInstallModule(self.getPackageDescriptor(cwd), cwd);

    return result;
  });

  // (4) finally link modules and install sub-dependencies.
  linkDependencies.forEach((item) => {
    promise = promise.then(() => {
      self.log.verbose(
        'Processing mapped module ' + item.name + '@' + item.version + ' for module ' + cwd);
      const exists = fs.existsSync(item.dest);
      const pkgIsSymLink = exists && fs.lstatSync(item.dest).isSymbolicLink();

      // don't override by default
      if (program.copy) {
        // remove any existing symlinks
        if (pkgIsSymLink) {
          rimraf.sync(item.dest);
        }

        // Check to see if this is a stub package. If so, delete and continue with the copy
        const stubMarker = path.join(item.dest, 'npm-workspace-stub');
        if (exists && fs.existsSync(stubMarker)) {
          rimraf.sync(item.dest);
        }

        // copy if not already present
        if (!fs.existsSync(item.dest)) {
          self.log.info('Copying ' + item.dest + ' from ' + item.mapping);
          const copy = when.promise((resolve, reject) => {
            ncp(item.mapping, item.dest, (err) => {
              if (err) {
                return reject(err);
              }
              // remove .git if options say so
              if (program.removeGit) {
                self.log.info('Cleaning .git directory ' + path.join(item.dest, '.git'));
                rimraf.sync(path.join(item.dest, '.git'));
                rimraf.sync(path.join(item.dest, '.gitignore'));
              }
              resolve();
            });
          });
          return copy;
        }
      } else if (/* not a copy, and */!pkgIsSymLink) {
        rimraf.sync(item.dest); // remove dummy package

        fs.symlinkSync(item.mapping, item.dest, 'dir');
        self.log.info('Created link ' + item.dest + ' -> ' + item.mapping);

        self.postInstallModule(self.getPackageDescriptor(item.mapping), item.mapping);
      }

      // now we make sure we fully install this linked module
    }).then(() => {
      return self.install(item.dest, installed); // Future : only do this if we haven't seen it
                                                 // before
    }).then(() => {
      results.linked[item.name] = item.version;
    });
  });

  // All install promises hooked up, return them to be run
  return promise.then(() => {
    return results;
  });
};


self.isRoot = (root) => {
  return path.resolve('/') === path.resolve(root);
};


self.normalizeDescriptor = (cwd, descriptorIn) => {
  const descriptor = _.cloneDeep(descriptorIn);

  // resolve dirs for the the 'link' property
  const newLinks = {};
  _.each(descriptor.links, (dir, modName) => {
    newLinks[modName] = path.resolve(cwd, dir);
  });
  descriptor.links = newLinks;

  return descriptor;
};

// read the 'package.json' file in the current directory
self.getPackageDescriptor = (cwd, nothrow) => {
  const fileDesc = path.resolve(cwd, 'package.json');
  if (fs.existsSync(fileDesc)) {
    return require(fileDesc);
  }

  if (!nothrow) {
    throw new Error('Cannot find package.json');
  }
  // don't go upper (for now)
  return null;
};

// recurse up from current location to find 'workspace.json'
self.getWorkspaceDescriptor = (cwd, shallow, nothrow) => {
  const fileDesc = path.resolve(cwd, DESCRIPTOR_NAME);
  if (fs.existsSync(fileDesc)) {
    return self.normalizeDescriptor(cwd, require(fileDesc));
  } else if (shallow || self.isRoot(cwd)) {
    if (nothrow) {
      return null;
    }
    throw new Error('Cannot find workspace.json');
  }

  return self.getWorkspaceDescriptor(path.resolve(cwd, '../'), shallow, nothrow);
};


self.clean = (cwd) => {
  const wsDesc = self.getWorkspaceDescriptor(cwd, true, true);
  let ret = when.resolve();
  if (wsDesc) {
    // we are in a workspace
    ret = when.resolve(self.cleanWorkspace(cwd));
  }

  const pkg = self.getPackageDescriptor(cwd, true);
  if (pkg) {
    // we are in a module dir
    ret = when(ret, () => {
      return self.cleanModule(cwd);
    });
  }

  return ret;
};

function longestFirst(a, b) {
  return b.length - a.length;
}

self.cleanWorkspace = (cwd) => {
  // let's be sure we are in a workspace
  if (!self.getWorkspaceDescriptor(cwd, true, true)) {
    return;
  }
  self.log.info('Cleaning workspace ' + cwd);

  const files = self.descendantsExcludingNpmModules(cwd, program.recursive);
  files.sort(longestFirst); // less likely to break symlinks on Windows.

  _.each(files, (file) => {
    self.cleanModule(file);
  });
};

self.cleanModule = (cwd) => {
  // let's be sure we are in a module
  if (!self.getPackageDescriptor(cwd, true)) {
    return;
  }
  self.log.info('Cleaning module ' + cwd);
  rimraf.sync(path.resolve(cwd, 'node_modules'));
};
