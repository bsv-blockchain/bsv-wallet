require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'YubiKeyPiv'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://github.com/Calgooon/bsv-browser'
  s.license      = 'Open BSV'
  s.authors      = 'BSV Browser'
  s.platforms    = { ios: '15.1' }
  s.source       = { git: '.', tag: s.version.to_s }
  s.source_files = ['ios/*.swift']
  # Offline-only manufacturer attestation roots/intermediates. Native code
  # validates the exact SHA-256 certificate allowlist before use.
  s.resource_bundles = {
    'YubiKeyPivAttestation' => ['attestation/yubico-vault-attestation.pem']
  }
  # Yubico's CocoaPods-published `YubiKit` pod tops out at 4.4.x (newer work
  # moved to Swift Package Manager). 4.4.1 has everything we use — the
  # YKFSmartCardConnection CCID transport (since 4.3) and YKFPIVSession's
  # generateKeyInSlot (ECC P-256 keygen) and signWithKey(in:type:algorithm:
  # message:) for signing a digest directly. It also fixes 4.4.0's double
  # completion bug in signWithKeyInSlot. The R1 private key is generated on the
  # card and never leaves it.
  s.dependency 'YubiKit', '~> 4.4.1'

  load File.join(__dir__, 'nitrogen', 'generated', 'ios', 'YubiKeyPiv+autolinking.rb')
  add_nitrogen_files(s)

  install_modules_dependencies(s)
end
