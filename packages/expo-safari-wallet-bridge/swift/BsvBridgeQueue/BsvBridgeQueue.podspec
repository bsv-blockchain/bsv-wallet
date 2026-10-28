Pod::Spec.new do |s|
  s.name = 'BsvBridgeQueue'
  s.version = '0.0.0'
  s.summary = 'Sealed App Group request queue shared by the app and the Safari extension.'
  s.homepage = 'https://github.com/bsv-blockchain/bsv-wallet'
  s.license = { :type => 'Open BSV' }
  s.author = 'BSV Association'
  s.platforms = { :ios => '15.1' }
  s.source = { :path => '.' }
  s.source_files = 'Sources/BsvBridgeQueue/**/*.swift'
  s.swift_version = '5.9'
  s.pod_target_xcconfig = { 'APPLICATION_EXTENSION_API_ONLY' => 'YES' }
end
