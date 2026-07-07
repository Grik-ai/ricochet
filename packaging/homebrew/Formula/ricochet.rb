class Ricochet < Formula
  desc "Installer for the Ricochet VS Code-compatible extension"
  homepage "https://grik.io/ricochet"
  url "https://github.com/Grik-ai/ricochet/releases/download/v0.2.12/install.sh",
      using: :nounzip
  sha256 "a66c197784d0b6bb2ddaacfb5dd750629fa55936ead3c3aae650f94051789f93"
  license "Apache-2.0"
  head "https://github.com/Grik-ai/ricochet.git", branch: "main"

  def install
    installer = build.head? ? "installer/install.sh" : "install.sh"
    chmod 0755, installer
    bin.install installer => "ricochet-install"
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
