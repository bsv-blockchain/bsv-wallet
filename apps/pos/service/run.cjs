// Development/reference host. The Go wallet-toolbox command is the deployment target.
const fs = require('node:fs')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    filename
  )
require('./server.ts')
