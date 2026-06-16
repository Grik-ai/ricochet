class Ricochet < Formula
  desc "Installer for the Ricochet VS Code-compatible extension"
  homepage "https://grik.io/ricochet"
  url "https://github.com/Grik-ai/ricochet.git",
      tag: "v0.1.0"
  license "Apache-2.0"
  head "https://github.com/Grik-ai/ricochet.git", branch: "main"

  depends_on "node"

  def install
    bin.install "installer/bin/ricochet-install.js" => "ricochet-install"
    libexec.install "installer/lib"

    inreplace bin/"ricochet-install",
      "require('../lib/installer')",
      "require('#{libexec}/lib/installer')"
  end

  def caveats
    <<~EOS
      Ricochet is installed through VS Code-compatible editors.

      To install the extension into VS Code, Cursor, or Windsurf, run:
        ricochet-install

      To target one editor:
        ricochet-install --editor cursor
    EOS
  end

  test do
    assert_match "Ricochet installer", shell_output("#{bin}/ricochet-install --help")
  end
end
