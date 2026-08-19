# Code signing policy

QX 影视 is an open-source Windows x64 application distributed from the
[byqianye/QX repository](https://github.com/byqianye/QX).

## Provider

Free code signing is provided by SignPath.io, with the certificate issued by
SignPath Foundation. A signed installer is published only after the release
workflow has passed its automated checks and the configured signing policy has
approved the request.

## Roles

- Committer and maintainer: [@byqianye](https://github.com/byqianye).
- Reviewers: changes from anyone other than the maintainer require review by
  the maintainer before a release tag is created.
- Approver: the maintainer approves a release only after the repository tests,
  clean Windows E2E checks, and release-evidence checks pass.

The GitHub repository and the SignPath project are the source of truth for
access control. The release workflow does not contain signing credentials.

## Release rules

1. Releases are created from a version tag matching `package.json`.
2. The GitHub-hosted workflow builds the installer and uploads the unsigned
   artifact to SignPath; it never signs on a developer workstation.
3. The published release must include the signed installer, component manifest,
   component signature, public key, and machine-verifiable evidence.
4. Unsigned or locally self-signed installers are test artifacts only and are
   not presented as production releases.

## Privacy

This program will not transfer information to other networked systems unless
the user or the person installing or operating the application specifically
requests it. The application does not ship third-party media sources,
credentials, cookies, DRM bypasses, or a hosted parsing service. Release
automation sends only the build artifact and the metadata required by the
configured signing service.

See the [SignPath Foundation conditions](https://signpath.org/terms.html) and
the repository [MIT license](LICENSE).
