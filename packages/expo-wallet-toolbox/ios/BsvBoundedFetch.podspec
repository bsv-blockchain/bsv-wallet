require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'BsvBoundedFetch'
  s.version = package['version']
  s.summary = 'Native receive-time byte limits for wallet HTTP responses'
  s.description = s.summary
  s.license = package['license']
  s.author = 'BSV Association'
  s.homepage = 'https://github.com/bsv-blockchain/bsv-wallet'
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/bsv-blockchain/bsv-wallet.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
