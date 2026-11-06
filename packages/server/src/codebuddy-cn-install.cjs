const { findCodeBuddy, installCodeBuddy } = require('./codebuddy-cn-runtime.cjs')

try {
  findCodeBuddy()
} catch {
  installCodeBuddy().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
