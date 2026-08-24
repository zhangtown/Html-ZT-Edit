// No-op Windows signer for electron-builder.
// When this script is set as the "sign" hook, electron-builder uses it
// INSTEAD of downloading WinCodeSign. The executable stays unsigned,
// which is perfectly fine for a local/personal tool.
module.exports = async function customSign(/* configuration, packager */) {
  // Intentionally do nothing: leave the .exe unsigned.
}
