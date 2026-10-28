require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'BsvBridge'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.license = package['license']
  s.author = 'BSV Association'
  s.homepage = 'https://github.com/bsv-blockchain/bsv-wallet'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/bsv-blockchain/bsv-wallet.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Default (S1.pod): the queue is its own pod, shared with the Safari extension target.
  # Delta S1.fileref: drop this dependency and compile the same Swift files here instead:
  #   s.source_files = 'BsvBridgeModule.swift', '../swift/BsvBridgeQueue/Sources/BsvBridgeQueue/**/*.swift'
  s.dependency 'BsvBridgeQueue'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '*.swift'
end
