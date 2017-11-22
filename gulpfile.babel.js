/*jshint esversion: 6 */
import del from 'del';
import extend from 'node.extend';
import fs from 'fs-extra';
import gulp from 'gulp';
import gulpLoadPlugins from 'gulp-load-plugins';
import http from 'http';
import jsonpath from 'JSONPath';
import lazypipe from 'lazypipe';
import merge from 'merge-stream';
import netrc from 'netrc';
import path from 'path';
import request from 'request-promise';
import runSequence from 'run-sequence';
import s2t from 'string-to-template';
import through2 from 'through2';
import url from 'url';
import File from 'vinyl';
import yargs from 'yargs';
import _ from 'lodash';

const errors = require('request-promise/errors');

const plugins = gulpLoadPlugins({
    camelize: true
});

let email;
let password;

const OPTS = {
    'management-server-url': {
        alias: 'm',
        describe: 'Management server URL',
        type: 'string',
        default: 'https://api.enterprise.apigee.com/v1'
    },
    'user': {
        alias: 'u',
        describe: 'Apigee user',
        type: 'string'
    },
    'password': {
        alias: 'p',
        describe: 'Apigee password',
        type: 'string'
    },
    'organization': {
        alias: 'o',
        describe: 'Apigee organization',
        type: 'string'
    },
    'environment': {
        alias: 'e',
        describe: 'Apigee environment',
        type: 'string'
    },
    'override': {
        alias: 'w',
        describe: 'Create a new revision of the API proxy',
        type: 'boolean',
        default: false
    },
    'deployment-suffix': {
        alias: 's',
        describe: 'Deployment suffix',
        type: 'string',
        default: '-' + process.env.USER
    },
    'file': {
        alias: 'f',
        describe: 'file',
        type: 'string'
    },
    'keystore-dir': {
        alias: 'k',
        describe: 'Directory containing the private keys / certificates to upload',
        default: 'keystore'
    },
    'debug': {
        alias: 'd',
        describe: 'Make the script verbose during the operation',
        type: 'boolean',
        default: false
    }
};

const addCommandOpts = (yargs, requiredOpts, otherOpts) => {
    var opts = [].concat(requiredOpts, otherOpts);
    for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        yargs = yargs.option(opt, OPTS[opt]);
    }
    yargs = yargs.demandOption(requiredOpts);
    return yargs;
};

const areCredentialsAvailable = (argv, options) => {
    if (argv.u && argv.p) {
        email = argv.u;
        password = argv.p;
    } else {
        // If no credentials were passed in the command line we get them from ~/.netrc or %HOME%/_netrc
        var isWin = /^win/.test(process.platform);
        const config = (isWin) ? netrc(path.join(process.env.HOME, "_netrc")) : netrc();
        let auth = config[url.parse(argv.m).hostname];
        if (!auth) {
            throw new Error('Credentials have not been set');
        }
        email = auth.login;
        password = auth.password;
    }
    return true;
};

const argv = yargs
    .command('create-bundle', 'Create API proxy / shared flow bundle', (yargs) => {
        return addCommandOpts(yargs, [], ['deployment-suffix']);
    }).command('deploy', 'Deploy API proxy / shared flow bundle ', (yargs) => {
        return addCommandOpts(yargs, ['organization', 'environment'], ['management-server-url', 'user', 'password', 'override', 'deployment-suffix', 'debug']).check(areCredentialsAvailable);
    }).command('deploy-and-test', 'Deploy API proxy and execute integration tests', (yargs) => {
        return addCommandOpts(yargs, ['organization', 'environment'], ['management-server-url', 'user', 'password', 'override', 'deployment-suffix', 'debug']).check(areCredentialsAvailable);
    }).command('test', 'Execute integration tests for API proxy', (yargs) => {
        return addCommandOpts(yargs, ['organization', 'environment'], ['deployment-suffix', 'debug']);
    }).command('export-env-config', 'Export environment configuration', (yargs) => {
        return addCommandOpts(yargs, ['organization', 'environment', 'file'], ['management-server-url', 'user', 'password', 'debug']).check(areCredentialsAvailable);
    }).command('import-env-config', 'Import environment configuration', (yargs) => {
        return addCommandOpts(yargs, ['organization', 'environment'], ['management-server-url', 'user', 'password', 'file', 'keystore-dir', 'debug']).check(areCredentialsAvailable);
    }).command('export-publish-config', 'Export publish configuration', (yargs) => {
        return addCommandOpts(yargs, ['organization', 'file'], ['management-server-url', 'user', 'password', 'debug']).check(areCredentialsAvailable);
    }).command('import-publish-config', 'Export publish configuration', (yargs) => {
        return addCommandOpts(yargs, ['organization', 'file'], ['management-server-url', 'user', 'password', 'debug']).check(areCredentialsAvailable);
    })
    .strict()
    .help()
    .argv;

const mgmntServerUrl = argv.m;
const org = argv.o;
const env = argv.e;
const deploymentSuffix = argv.s;
const override = argv.w;
const file = argv.f;
const ksDir = argv.k;
const debug = argv.d;

const log = (message, force) => {
    if (debug || force) {
        plugins.util.log(message);
    }
};

// Variables to be interpolated in the test settings
const tokens = {
    org: org,
    env: env,
    deploymentSuffix: deploymentSuffix
};

// Directory where the API proxy bundle will be prepared
const BUILD_DIR = 'build';
// Directory where the API proxy bundle will be saved
const DIST_DIR = 'dist';

const FILENAME_SETTINGS_JSON = 'settings.json';

const expand = (value, tokens) => {
    if (_.isArray(value)) {
        return value.map(item => expand(item, tokens));
    } else if (_.isObject(value)) {
        return _.mapValues(value, item => expand(item, tokens));
    } else {
        return s2t(value, tokens);
    }
};

const loadSettings = () => {
    let settings = {};
    let data;

    // Loading test settings for an specific org and env
    if (fs.existsSync(FILENAME_SETTINGS_JSON)) {
        data = require(`./${FILENAME_SETTINGS_JSON}`);
    }

    if (data) {
        let defaultData = {};
        if (data.default) {
            defaultData = data.default;
        }
        settings = (data[org] && data[org][env]) ? extend(true, extend(true, {}, expand(defaultData, tokens)), expand(data[org][env], tokens)) : expand(defaultData, tokens);
    }

    return settings;

};

let bundleName;

let bundleType;

if (fs.existsSync('apiproxy')) {
    bundleType = 'apiproxy';
} else if (fs.existsSync('sharedflowbundle')) {
    bundleType = 'sharedflowbundle';
} else {
    throw new Error('Unsupported bundle type');
}

 const settings = loadSettings();

// Default settings for http requests.
var httpAgent = new http.Agent();
httpAgent.maxSockets = 2;

// Default settings for http requests.
const req = request.defaults({
    baseUrl: mgmntServerUrl,
    pool: httpAgent,
    auth: {
        user: email,
        pass: password
    }
});

const archive = (dir) => {
    const prefix = `${dir}/resources/node`;
    return fs.exists(prefix)
        .then(result => {
            if (result) {
                log('Installing node dependencies...');
                return new Promise((resolve, reject) => {
                    gulp.src(`${prefix}/package.json`).pipe(plugins.install(() => {
                        log('Zipping node_modules directory...');
                        gulp.src(`${prefix}/node_modules/**`, {
                            base: prefix
                        }).pipe(plugins.zip('node_modules.zip')).pipe(gulp.dest(`${prefix}`)).
                        on('end', resolve).on('error', reject);
                    }));
                }).then(result => {
                    return del(`${prefix}/node_modules`);
                });
            }
            return;
        }).then(result => {
            return new Promise((resolve, reject) => {
                log(`Zipping ${dir} directory...`);
                var chunks = [];
                gulp.src(`${dir}/**`, {
                    base: path.basename(path.dirname(dir))
                }).pipe(plugins.zip('bundle.zip')).on('data', data => {
                    chunks.push(data.contents);
                }).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
            });
        });
};

const jsFilter = plugins.filter(['**/*.js', '!**/node_modules/**'], {
    restore: true
});

const xmlFilter = plugins.filter(['**/*.xml'], {
    restore: true
});

const jsonFilter = plugins.filter(['apiproxy/{policies,proxies,targets}/*.json'], {
    restore: true
});

const excludesFilter = plugins.filter(['**', '!apiproxy/{policies,proxies,targets}/*.{json,ejs}']);

const jshintTasks = lazypipe().pipe(plugins.jshint)
    .pipe(plugins.jshint.reporter, 'jshint-stylish')
    .pipe(plugins.jshint.reporter, 'fail');

gulp.task('default', ['deploy-and-test']);

gulp.task('clean', () => {
    return del([BUILD_DIR, DIST_DIR]);
});

gulp.task('build-java-callouts', () => {
    if (fs.existsSync('java-callouts')) {
        return gulp.src('java-callouts/*').pipe(plugins.flatmap((stream, file) => {
            if (file.isDirectory()) {
                const name = path.basename(file.path);
                const buildAndPackage = gulp.src(`${file.path}/src/**/*.java`)
                    .pipe(plugins.javac(`${name}.jar`)
                        .addLibraries(`${file.path}/lib/**/*.jar`))
                    .pipe(gulp.dest('build/apiproxy/resources/java'));
                const copyDependencies = gulp.src(`${file.path}/lib/**/*.jar`)
                    .pipe(gulp.dest(`${BUILD_DIR}/apiproxy/resources/java`));
                return merge(buildAndPackage, copyDependencies);
            } else {
                return stream;
            }
        }));
    }
});

const buildBundle = (bundleType) => {
    let stream = gulp.src([`${bundleType}/**`, `common/${bundleType}/**`]);
    stream = stream.pipe(jsFilter)
        .pipe(jshintTasks())
        .pipe(jsFilter.restore)
        .pipe(jsonFilter)
        .pipe(through2.obj(function (file, enc, next) {
            // Generating XML descriptors from a template applying data available in JSON file
            const contents = JSON.parse(file.contents.toString('utf8'));
            if (_.isArray(contents)) {
                contents.map((item => {
                    if (item.name) {
                        const basename = path.basename(file.path, '.json') + '.ejs';
                        // Checking if the template is in the same folder
                        let templateFile = path.join(path.dirname(file.path), basename);
                        if (!fs.existsSync(templateFile)) {
                            templateFile = path.join(__dirname, 'common/partials', basename);
                        }
                        const data = JSON.stringify(item);
                        // Workaround to fix problem in Windows
                        const escapedTemplateFilePath = templateFile.replace(/\\/g, "/");
                        const newFile = new File({
                            cwd: file.cwd,
                            base: file.base,
                            path: path.join(path.dirname(file.path), `${item.name}.xml`),
                            contents: new Buffer(`<%- include('${escapedTemplateFilePath}', ${data}) %>`),
                        });
                        this.push(newFile);
                    } else {
                        throw new Error(`Item in file ${file.path} is missing name property`);
                    }
                }));
            } else {
                throw new Error(`File ${file.path} should contain a JSON array`);
            }
            next();
        }))
        .pipe(jsonFilter.restore)
        .pipe(xmlFilter)
        .pipe(plugins.if(debug, plugins.logger({
            beforeEach: 'Applying partials to ',
            colors: true
        })))
        .pipe(plugins.ejs(Object.assign({
            partialsDir: path.resolve(__dirname, 'common/partials'),
        }, settings)))
        .pipe(plugins.if(debug, plugins.logger({
            beforeEach: 'Prettifying ',
            colors: true
        })))
        .pipe(plugins.prettyData({
            type: 'prettify'
        }))
        .pipe(xmlFilter.restore);

    if (bundleType === 'apiproxy') {

        const apiProxyXmlFilter = plugins.filter(['apiproxy/*.xml'], {
            restore: true
        });

        const proxyEndpointXmlFilter = plugins.filter(['apiproxy/proxies/*.xml'], {
            restore: true
        });

        stream = stream.pipe(apiProxyXmlFilter)
            .pipe(plugins.if(debug, plugins.logger({
                beforeEach: 'Updating API proxy name in descriptor ',
                colors: true
            })))
            .pipe(plugins.xmlpoke({
                replacements: [{
                    xpath: '//APIProxy/@name',
                    value: node => {
                        // Appending deployment suffix to API proxy name
                        bundleName = node.nodeValue + deploymentSuffix;
                        return bundleName;
                    }
                }]
            })).pipe(apiProxyXmlFilter.restore)
            .pipe(proxyEndpointXmlFilter)
            .pipe(plugins.if(debug, plugins.logger({
                beforeEach: 'Updating base path in proxy endpoint ',
                colors: true
            })))
            .pipe(plugins.xmlpoke({
                replacements: [{
                    // Appending deployment suffix to API proxy name
                    xpath: '//ProxyEndpoint/HTTPProxyConnection/BasePath',
                    value: node => node.firstChild.data + deploymentSuffix
                }]
            }))
            .pipe(proxyEndpointXmlFilter.restore);

    } else if (bundleType === 'sharedflowbundle') {

        const sharedFlowBundleXmlFilter = plugins.filter(['sharedflowbundle/*.xml'], {
            restore: true
        });

        stream = stream.pipe(sharedFlowBundleXmlFilter)
            .pipe(plugins.if(debug, plugins.logger({
                beforeEach: 'Updating API proxy name in descriptor ',
                colors: true
            })))
            .pipe(plugins.xmlpoke({
                replacements: [{
                    xpath: '//SharedFlowBundle/@name',
                    value: node => {
                        // Appending deployment suffix to API proxy name
                        bundleName = node.nodeValue + deploymentSuffix;
                        return bundleName;
                    }
                }]
            }))
            .pipe(sharedFlowBundleXmlFilter.restore);

    }

    stream = stream.pipe(excludesFilter).pipe(gulp.dest(`${BUILD_DIR}/${bundleType}`));
    return stream;


};

gulp.task('build', () => {
    return buildBundle(bundleType);
});

gulp.task('build-all', callback => runSequence('clean', ['build-java-callouts', 'build'], () => callback()));

const createBundle = () => {

    return fs.ensureDir(DIST_DIR).then(result => {
        return archive(`${BUILD_DIR}/${bundleType}`);
    }).then(result => {
        return fs.writeFile(`${DIST_DIR}/${bundleType}.zip`, result);
    });

};

gulp.task('create-bundle', ['build-all'], () => {
    return createBundle(bundleType);
});


const deploy = (bundleType) => {
    let deployedRevision;
    log('Getting currently deployed revision');
    return req.get({
        uri: `/o/${org}/${bundleType}s/${bundleName}/deployments`,
        json: true,
        simple: false,
        transform: (body, response, resolveWithFullResponse) => {
            if (response.statusCode === 200) {
                return jsonpath({
                    json: body,
                    path: `$.environment[?(@.name=="${env}")].revision[0].name`,
                    wrap: false
                });
            }
            return;
        }
    }).then(result => {
        deployedRevision = result;
        if (deployedRevision) {
            log(`Currently Deployed Revision: ${deployedRevision}`);
        } else {
            log('API proxy does not exist');
        }
        return archive(`${BUILD_DIR}/apiproxy`);
    }).then(result => {
        let options = {
            body: result,
            headers: {
                'Content-Type': 'application/octet-stream'
            },
            transform2xxOnly: true,
            transform: (body, response, resolveWithFullResponse) => {
                return JSON.parse(body).revision;
            }
        };
        if (!deployedRevision || override) {
            log(`Importing new revision...`);
            options.uri = `/o/${org}/${bundleType}s`;
            options.qs = {
                action: 'import',
                name: bundleName,
                validate: true
            };
        } else {
            log(`Updating revision ${deployedRevision}...`);
            options.uri = `/o/${org}/${bundleType}s/${bundleName}/revisions/${deployedRevision}`;
        }
        let uri = (!deployedRevision || override) ? `/o/${org}/${bundleType}s?action=import&name=${bundleName}&validate=true` : `/o/${org}/${bundleType}s/${bundleName}/revisions/${deployedRevision}`;
        return req.post(options);
    }).then(result => {
        const revision = result;
        if (revision !== deployedRevision) {
            log('Deploying new revision...');
            let options = {
                uri: `/o/${org}/e/${env}/${bundleType}s/${bundleName}/revisions/${revision}/deployments`,
                json: true,
                transform2xxOnly: true,
                transform: (body, response, resolveWithFullResponse) => {
                    return jsonpath({
                        json: body,
                        path: `$.environment[?(@.environment=="${env}" && @.state=="deployed")].revision`,
                        wrap: false
                    });
                },
                form: {}
            };
            if (deployedRevision) {
                options.qs = {
                    override: true,
                    delay: 5
                };
            }
            return req.post(options);
        } else {
            log(`Updated revision: ${revision}`);
            return revision;
        }
    }).then((result) => {
        log(`Revision ${result} deployed in ${env} environment`);
    });
};

gulp.task('deploy', ['build-all'], () => {
    return deploy((bundleType === 'apiproxy') ? 'api' : 'sharedflow');
});

const getBasepath = (resourceType, resource) => {
    if (_.includes(['caches', 'keystores', 'keyvaluemaps', 'references', 'targetservers', 'virtualhosts'], resourceType)) {
        return `/o/${org}/e/${env}/${resourceType}`;
    } else if (_.includes(['apis', 'environments', 'apiproducts', 'companies', 'developers', 'apps'], resourceType)) {
        if (resourceType === 'apps' && resource) {
            if (resource.developerEmail) {
                return `/o/${org}/developers/${resource.developerEmail}/apps`;
            } else if (resource.companyName) {
                return `/o/${org}/developers/${resource.companyName}/apps`;
            } else {
                throw new Error(`app ${resource.name} needs to belong to a developer or a company`);
            }
        } else {
            return `/o/${org}/${resourceType}`;
        }
    } else {
        throw Error(`Unknown / unsupported resource type ${resourceType}`);
    }
};

const exportConfig = function (resourceTypes) {
    return Promise.all(resourceTypes.map(resourceType => {
        return req.get({
            uri: getBasepath(resourceType),
            json: true,
            transform2xxOnly: true,
            transform: (body, response, resolveWithFullResponse) => {
                if (resourceType === 'keyvaluemaps') {
                    return body.filter(item => !item.startsWith('__apigee__.'));
                }
                return body;
            }
        });
    })).then(result => {
        return Promise.all(resourceTypes.map((resourceType, index, length) => {
            return Promise.all(result[index].map(resource => {
                return req.get({
                    uri: getBasepath(resourceType) + '/' + resource,
                    json: true,
                    transform2xxOnly: true,
                    transform: (body, response, resolveWithFullResponse) => {
                        delete body.accessType;
                        delete body.organization;
                        delete body.organizationName;
                        delete body.createdAt;
                        delete body.createdBy;
                        delete body.lastModifiedAt;
                        delete body.lastModifiedBy;
                        return body;
                    }
                });
            }));
        }));
    }).then(result => {
        let envConfig = {};
        for (let i = 0; i < resourceTypes.length; i++) {
            const resourceType = resourceTypes[i];
            let resources;
            if (resourceType === 'apps') {
                let apps = [];
                for (let j = 0; j < resources.length; j++) {
                    let item = resources[i];
                    if (item.developerId) {
                        item.developerEmail = jsonpath({
                            json: result,
                            path: `$.developers[?(@.developerId=="${item.developerId}")].email`,
                            wrap: false
                        });
                        delete item.developerId;
                    }
                    apps.push(item);
                }
                resources = apps;
            } else {
                resources = result[i];
            }
            envConfig[resourceType] = resources;
        }
        return envConfig;
    }).then(result => {
        return fs.writeFile(file, JSON.stringify(result, undefined, 4));
    }).then(result => {
        log('Configuration exported', true);
    });
};


gulp.task('export-env-config', () => {
    return exportConfig(['caches', 'keyvaluemaps', 'references', 'targetservers', 'virtualhosts']);
});

gulp.task('export-publish-config', () => {
    return exportConfig(['apiproducts', 'companies', 'developers', 'apps']);
});

const importConfig = (envConfig) => {
    let cpsEnabled;
    let requests = [];
    return req.get({
        uri: `/o/${org}`,
        json: true,
        transform2xxOnly: true,
        transform: (body, response, resolveWithFullResponse) => {
            return jsonpath({
                json: body,
                path: '$.properties.property[?(@.name=="features.isCpsEnabled")].value',
                wrap: false
            });
        }
    }).then(result => {
        cpsEnabled = result;
        return Promise.all(Object.keys(envConfig).map(resourceType => {
            const resources = envConfig[resourceType];
            return Promise.all(resources.map(resource => {
                const basepath = getBasepath(resourceType, resource);
                const r = req.post({
                    uri: basepath,
                    json: true,
                    body: resource,
                    simple: false,
                    resolveWithFullResponse: true
                });
                requests.push(r);
                const name = (resourceType === 'developers') ? resource.email : resource.name;
                return new Promise((resolve, reject) => {
                    r.then(res => {
                        if (res.statusCode === 201) {
                            log(`${resourceType} => ${name} successfully created`);
                            if(resourceType === 'apps' && !_.isEmpty(res.body.credentials)) {
                                log(`${resourceType} => ${name} app credentials => consumerKey: ${res.body.credentials[0].consumerKey}, consumerSecret: ${res.body.credentials[0].consumerSecret}`, true);
                            }
                            resolve();
                        } else if (res.statusCode === 409) {
                            log(`${resourceType} => ${name} already exists`);
                            if (resourceType === 'keyvaluemaps' && cpsEnabled) {
                                req.get({
                                    uri: `${basepath}/${name}/keys`,
                                    json: true
                                }).then(body => {
                                    Promise.all(resource.entry.map(entry => {
                                        if (_.includes(body, entry.name)) {
                                            return req.put({
                                                uri: `${basepath}/${resource.name}/entries/${entry.name}`,
                                                json: true,
                                                body: entry
                                            }).then(res => {
                                                log(`${resourceType} => entry ${entry.name} in ${name} successfully updated`);
                                            }).catch(error => {
                                                log(`${resourceType} => entry ${entry.name} in ${name} could not be updated. Error => ${error.message}`, true);
                                            });
                                        } else {
                                            req.post({
                                                uri: `${basepath}/${resource.name}/entries`,
                                                json: true,
                                                body: entry
                                            }).then(rebody => {
                                                log(`${resourceType} => entry ${entry.name} in ${name} successfully created`);
                                            }).catch(error => {
                                                log(`${resourceType} => entry ${entry.name} in ${name} could not be created. Error => ${error.message}`, true);
                                            });
                                        }
                                    }), _.difference(body, resource.entry.map(entry => {
                                        return entry.name    
                                    })).map(entry => {
                                        req.delete({
                                            uri: `${basepath}/${resource.name}/entries/${entry}`,
                                            json: true,
                                        }).then(body => {
                                            log(`${resourceType} => entry ${entry} in ${name} successfully deleted`);
                                        }).catch(error => {
                                            log(`${resourceType} => entry ${entry} in ${name} could not be deleted. Error => ${error.message}`, true);
                                        });
                                    })).then(result => {
                                        log(`${resourceType} => ${name} successfully updated`);
                                        resolve();
                                    }).catch(error => {
                                        log(`${resourceType} => ${name} could not be updated. Error => ${error}`, true);
                                        resolve();
                                    });
                                }).catch(error => {
                                    log(`${resourceType} => Could not fetch keys for ${name}`, true);
                                    resolve();
                                });
                            } else {
                                req.put({
                                    uri: getBasepath(resourceType, resource) + `/${name}`,
                                    json: true,
                                    body: resource
                                }).then(body => {
                                    log(`${resourceType} => ${name} successfully updated`);
                                    if(resourceType === 'apps' && !_.isEmpty(body.credentials)) {
                                        log(`${resourceType} => ${name} app credentials => consumerKey: ${body.credentials[0].consumerKey}, consumerSecret: ${body.credentials[0].consumerSecret}`, true);
                                    }
                                    resolve();
                                }).catch(error => {
                                    log(`${resourceType} => ${name} could not be updated. Error => ${error}`, true);
                                    resolve();
                                });
                            }
                        } else if (res.statusCode === 403) {
                            reject('Forbidden. Check your credentials');
                        } else {
                            log(`${resourceType} => ${name} could not be created. Error => ${res.body.message}`);
                            resolve();
                        }
                    });
                });
            }));
        })).catch(error => {
            for (let i = 0; i < requests.length; i++) {
                requests[i].cancel();
            }
            throw error;
        });
    });
};

gulp.task('import-env-config', () => {
    let promises = [];
    if (fs.existsSync(file)) {
        promises.push(fs.readFile(file)
            .then(result => {
                return importConfig(JSON.parse(result));
            }));
    }
    if (ksDir && fs.existsSync(ksDir)) {
        let keystores = [];
        const basepath = getBasepath('keystores');
        promises.push(Promise.all(fs.readdirSync(ksDir).filter(basename => {
            return fs.statSync(path.join(ksDir, basename)).isDirectory();
        }).map(keystore => {
            return req.post({
                uri: basepath,
                json: true,
                body: {
                    name: keystore
                },
                simple: false,
                resolveWithFullResponse: true
            }).then(res => {
                if (res.statusCode === 201) {
                    log(`keystore ${keystore} successfully created`);
                    keystores.push(keystore);
                } else if (res.statusCode === 409) {
                    log(`keystore ${keystore} already exists`);
                    keystores.push(keystore);
                } else {
                    log(`keystore ${keystore} could not be created. Error => ${res.body.message}`, true);
                }
                return;
            });
        })).then(result => {
            return keystores;
        }).then(keystores => {
            return Promise.all(keystores.map(keystore => {
                return Promise.all(fs.readdirSync(path.join(ksDir, keystore)).filter(basename => {
                    return fs.statSync(path.join(ksDir, keystore, basename)).isDirectory();
                }).map(entry => {
                    const certFile = path.join(ksDir, keystore, entry, 'cert.pem');
                    const keyFile = path.join(ksDir, keystore, entry, 'key.pem');
                    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
                        return new Promise((resolve, reject) => {
                            let chunks = [];
                            gulp.src([certFile, keyFile]).
                            pipe(plugins.file('META-INF/descriptor.properties', 'certFile=cert.pem\nkeyFile=key.pem'))
                                .pipe(plugins.zip('keystore.jar'))
                                .on('data', data => chunks.push(data.contents))
                                .on('end', () => {
                                    resolve(Buffer.concat(chunks));
                                }).on('error', reject);
                        }).then(result => {
                            return req.post({
                                uri: `${basepath}/${keystore}/keys`,
                                qs: {
                                    alias: entry
                                },
                                body: result,
                                headers: {
                                    'Content-Type': 'application/octet-stream'
                                },
                                simple: false,
                                resolveWithFullResponse: true
                            }).then(res => {
                                if (res.statusCode === 204) {
                                    log(`key ${entry} successfuly uploaded to keystore ${keystore}`);
                                } else if (res.statusCode === 400) {
                                    log(`key ${entry} already exists keystore ${keystore}`);
                                }
                                return;
                            });
                        });
                    } else if (fs.existsSync(certFile)) {
                        return req.post({
                            uri: `${basepath}/${keystore}/certs`,
                            qs: {
                                alias: entry
                            },
                            body: fs.readFileSync(certFile),
                            headers: {
                                'Content-Type': 'application/octet-stream'
                            },
                            simple: false,
                            resolveWithFullResponse: true
                        }).then(res => {
                            if (res.statusCode === 204) {
                                log(`certificate ${entry} successfuly uploaded to keystore ${keystore}`);
                            } else if (res.statusCode === 409) {
                                log(`certificate ${entry} already exists keystore ${keystore}`);
                            }
                            return;
                        });
                    }
                    return;
                }));
            }));
        }));

    }
    return Promise.all(promises).then(result => {
        log('Configuration imported', true);
    }).catch(error => log(error.message, true));
});

gulp.task('import-publish-config', () => {
    if (fs.existsSync(file)) {
        let envConfig;
        let environments, apis, apiProductEnvironments, apiProductApis;
        return fs.readFile(file)
            .then(result => {
                let promises = [];
                envConfig = JSON.parse(result);
                if (envConfig.apiproducts) {
                    apiProductEnvironments = _.union(_.flatten(jsonpath({
                        json: envConfig,
                        path: '$.apiproducts[*].environments',
                        wrap: false
                    })));
                    apiProductApis = _.union(_.flatten(jsonpath({
                        json: envConfig,
                        path: '$.apiproducts[*].proxies',
                        wrap: false
                    })));
                    if (!_.isEmpty(apiProductEnvironments)) {
                        promises.push(req.get({
                            uri: getBasepath('environments'),
                            json: true
                        }));
                    } else {
                        promises.push(Promise.resolve([]));
                    }
                    if (!_.isEmpty(apiProductApis)) {
                        promises.push(req.get({
                            uri: getBasepath('apis'),
                            json: true
                        }));
                    } else {
                        promises.push(Promise.resolve([]));
                    }
                }
                return Promise.all(promises);
            }).then(result => {
                environments = result[0];
                apis = result[1];
                const missingEnvironments = _.difference(apiProductEnvironments, environments);
                if (!_.isEmpty(missingEnvironments)) {
                    throw new Error(`Environments ${missingEnvironments} do not exist in organization ${org}`);
                }
                const missingApis = _.difference(apiProductApis, apis);
                if (!_.isEmpty(missingApis)) {
                    throw new Error(`API Proxies ${missingApis} do not exist in organization ${org}`);
                }
            }).then(result => {
                return importConfig(_.pickBy(envConfig, (value, key) => _.includes(["apiproducts", "companies", "developers"], key)));
            }).then(result => {
                return importConfig(_.pickBy(envConfig, (value, key) => _.includes(["apps"], key)));
            }).then(result => {
                log('Configuration imported', true);
            }).catch(error => {
                log(error.message, true);
            });
    } else {
        log(`File ${file} does not exist`, true);
    }
});

gulp.task('test', () => {
    if (fs.existsSync('test/integration')) {
        const wp = JSON.stringify(settings);
        let args = ['node', 'node_modules/.bin/cucumberjs'];
        args = args.concat(['--compiler', 'js:babel-register', '--world-parameters', wp, '--format', 'node_modules/cucumber-pretty', '--require', './node_modules/apickli/apickli-gherkin.js']);
        // Adding common
        if (fs.existsSync('common/test/integration/features/step_definitions')) {
            args = args.concat(['--require', 'common/test/integration/features/step_definitions']);
        }
        if (fs.existsSync('test/integration/features/step_definitions')) {
            args = args.concat(['--require', 'test/integration/features/step_definitions']);
        }
        if (fs.existsSync('common/test/integration/features')) {
            args = args.concat('common/test/integration/features');
        }
        args = args.concat('test/integration/features');
        const cli = new(require('cucumber').Cli)({
            argv: args,
            cwd: '.',
            stdout: process.stdout
        });
        return cli.run();
    }
});

gulp.task('deploy-and-test', callback => runSequence('deploy', 'test', () => callback()));
