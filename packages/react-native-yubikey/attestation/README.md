# Pinned Yubico PIV attestation authorities

`yubico-vault-attestation.pem` contains only the production certificates that
the Vault native verifier accepts. The application never consults the system
trust store or downloads certificate material at runtime.

The certificates were copied on 2026-09-11 from Yubico's authoritative PKI
publication and PIV attestation documentation:

- https://developers.yubico.com/PKI/yubico-ca-certs.txt
- https://developers.yubico.com/PKI/yubico-intermediate.pem
- https://developers.yubico.com/PKI/yubico-piv-ca-1.pem
- https://developers.yubico.com/PIV/Introduction/piv-attestation-ca-old.pem
- https://developers.yubico.com/PKI/yubico-fido-ca-1.pem
- https://developers.yubico.com/PKI/yubico-ca-1.pem
- https://developers.yubico.com/PIV/Introduction/PIV_attestation.html

The bundle is deliberately an allowlist. Preview CAs and authorities for FIDO,
OpenPGP, Secure Domain, and YubiHSM attestations are excluded. The pre-5.7.4
roots include both versions of Yubico PIV Root CA Serial 263751 (the 2018
replacement changed certificate constraints without changing the key) and the
U2F root used for some early production YubiKey 4 PIV attestations. Firmware
5.7.4 and later uses the Attestation Root 1 chain through A/B and PIV A/B/B2
intermediates.

SHA-256 certificate fingerprints:

| Role | Subject CN | SHA-256 |
| --- | --- | --- |
| legacy root | Yubico PIV Root CA Serial 263751 (pre-2018 certificate) | `7E996A28E3055223733C9AEC897900EDA9B746E3E15D419556AC6A1179879A50` |
| legacy root | Yubico PIV Root CA Serial 263751 | `63ECE914E54DD87915F34033C85AF4C0696BA1512F8ADD66CED738331207B546` |
| legacy root | Yubico U2F Root CA Serial 457200631 | `0FA1386F80EB8713263AE5C1D84DEB455BDF08AEA50AB05503CEFEE82B092D42` |
| current root | Yubico Attestation Root 1 | `62760C6A6EF91679F454C8902B80FD009825B3F25DA90F1FBACE2EC6586CD5A8` |
| current intermediate | Yubico Attestation Intermediate A 1 | `4698A1D3389C3EC60016C216250F1D0439922832D65142327436376DC2942B55` |
| current intermediate | Yubico Attestation Intermediate B 1 | `D4CC3F456FDAF4E7812A21AAB1DFE9D8E27D24E2FD2D6F21C9940109F0DAA754` |
| PIV intermediate | Yubico PIV Attestation A 1 | `6DE693F05376F5D8CA29069261E1C8626C75D503BD2EDBFD75354CAD1F722870` |
| PIV intermediate | Yubico PIV Attestation B 1 | `2D55B7998F4E42569D6D8FA382B6DC77D1DACF07358B19701163892922B17052` |
| PIV intermediate | Yubico PIV Attestation B2 1 | `0C90B7D184A36EDF50A35F9BE935F0C5689BFDCFE5BDD073366CAFB49061A440` |

The native implementations verify this exact fingerprint set before using the
bundle, so an accidental certificate addition or replacement fails closed.

The Android unit suite validates a synthetic F9/slot chain plus negative key,
serial, policy, root, and DER cases. The iOS smoke test validates this pinned
bundle and its closed signature graph without using an Apple trust store:

```sh
xcrun swiftc ios/YubicoPivAttestation.swift tests/iosAttestationSmoke.swift \
  -o /tmp/YubicoPivAttestationSmoke
/tmp/YubicoPivAttestationSmoke attestation/yubico-vault-attestation.pem
```
