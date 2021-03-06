var fs = require('fs');
var os = require('os');
var child_process = require('child_process');
var abiMap = require('./abi-map.json');

var abi = abiMap[process.version];

if (abi) {
  var addonPath = `./addons/${os.platform()}-${process.arch}/autoprofile-addon-v${abi}.node`;
  if (fs.existsSync(addonPath)) {
    console.log('Pre-built version of AutoProfile addon found, not building.');
    return;
  } else {
    console.log('Pre-built version of AutoProfile is not available, fallback to node-gyp.');
  }
} else {
  console.log('Pre-built version of AutoProfile is not available (ABI not found), fallback to node-gyp.');
}

var gyp = child_process.spawn('node-gyp', ['rebuild'], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });

gyp.on('error', err => {
  console.error('node-gyp not found.');
  process.exit(1);
});

gyp.on('close', code => {
  process.exit(code);
});
