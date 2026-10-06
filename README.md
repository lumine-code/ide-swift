# ide-swift

Provide Swift language features with SourceKit-LSP.

Registers the official [SourceKit-LSP](https://github.com/swiftlang/sourcekit-lsp) server from a complete Swift toolchain with `ide`. Install `language-swift` for syntax highlighting and the editor service frontends for the features you want to display.

## Features

- **Code intelligence**: supplies compiler diagnostics, completion, documentation and signature help.
- **Navigation**: finds definitions, references, document and workspace symbols, call hierarchies and type hierarchies across Swift modules.
- **Refactoring**: renames symbols and applies compiler fixes and refactorings through workspace edits.
- **Formatting**: formats documents and selections with the toolchain formatter and respects project .swift-format files.
- **Inline information**: supplies inferred type hints and semantic tokens.
- **Toolchain discovery**: selects an explicit server or toolchain, an editor-managed installation, PATH or the selected Xcode toolchain.
- **Managed installation**: preserves a complete matched Swift compiler, server, SDK and runtime with verified official distribution provenance.
- **Project support**: loads Swift Package Manager projects and preserves their dependency graph and SourceKit-LSP configuration.

## Installation

To install `ide-swift` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-swift`.

Install `ide` and `language-swift`, then use `ide:manage-servers` to install a complete Swift toolchain, or install [Swift](https://www.swift.org/install/) yourself. SourceKit-LSP, the Swift compiler, formatter, SDK resources and runtime must remain at matching versions. Selecting a copied server executable alone cannot supply that environment.

Managed installation downloads the complete official toolchain. Linux archives are verified against Swift's detached release signature and the pinned official signing-key fingerprint. macOS packages require a trusted Swift Developer ID signature and are expanded as data. Windows downloads use the published WinGet SHA256 hash; the Apple installer bundle and its embedded payload hashes are verified before a MIT-licensed extraction helper reads its MSI files. No installer action runs, no system registry entry is written, and removing the managed copy leaves separately installed toolchains intact. Downloads are large: Swift 6.4 uses about 1.1 GB on Ubuntu and 2.1 GB on Windows before extraction.

Windows additionally needs the platform C++ build tools and Windows SDK described in [Swift's installation instructions](https://www.swift.org/install/windows/manual/). These dependencies remain your system's responsibility; the adapter does not install Visual Studio or a Windows SDK. On macOS, Xcode or compatible command-line SDK tools provide platform resources. Linux requires the system libraries for the selected Swift distribution.

## Usage

Open the directory containing `Package.swift`, then open a Swift source file. SourceKit-LSP discovers the package's targets and dependencies and performs background indexing with current Swift toolchains. An existing `SDKROOT` stays authoritative, and project `.sourcekit-lsp/config.json` settings override the adapter's initialization options. Keep project SDK and compiler requirements intact when choosing a different toolchain.

Project `.swift-format` files govern formatting. Feature switches control which server results the editor uses and support language-scoped overrides. Swift run, debug and test code lenses require client integrations that are not available here, so they are disabled. Standard compiler quickfixes and server refactoring commands remain available.

## Services

- `ide`: consumed to register SourceKit-LSP and its matched toolchain.
- `background-tips.provider`: provided to background-tips to describe Swift packages and toolchain setup.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
