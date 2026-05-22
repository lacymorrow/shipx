import { describe, expect, test } from "bun:test";
import { updateFormulaUrlAndSha, updateBinaryFormulaAssets } from "./homebrew-formula.ts";

const SIMPLE_FORMULA = `class Shipx < Formula
  desc "Interactive release CLI"
  homepage "https://github.com/lacymorrow/shipx"
  url "https://github.com/lacymorrow/shipx/archive/refs/tags/v0.1.10.tar.gz"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license "MIT"
end
`;

const FORMULA_WITH_BOTTLE = `class Shipx < Formula
  desc "Interactive release CLI"
  homepage "https://github.com/lacymorrow/shipx"
  url "https://github.com/lacymorrow/shipx/archive/refs/tags/v0.1.10.tar.gz"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license "MIT"

  bottle do
    sha256 cellar: :any_skip_relocation, arm64_ventura: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    sha256 cellar: :any_skip_relocation, ventura: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  end
end
`;

const FORMULA_WITH_RESOURCE = `class Shipx < Formula
  desc "Interactive release CLI"
  homepage "https://github.com/lacymorrow/shipx"
  url "https://github.com/lacymorrow/shipx/archive/refs/tags/v0.1.10.tar.gz"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license "MIT"

  resource "helper" do
    url "https://example.com/helper-1.0.tar.gz"
    sha256 "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  end
end
`;

const RELEASE_ASSET_FORMULA = `class Shipx < Formula
  desc "Interactive release CLI"
  homepage "https://github.com/lacymorrow/shipx"
  url "https://github.com/lacymorrow/shipx/releases/download/v0.1.10/shipx-0.1.10.tar.gz"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  license "MIT"
end
`;

const NEW_URL = "https://github.com/lacymorrow/shipx/archive/refs/tags/v0.1.11.tar.gz";
const NEW_SHA = "1111111111111111111111111111111111111111111111111111111111111111";

describe("updateFormulaUrlAndSha", () => {
	test("updates url and sha256 in a simple formula", () => {
		const result = updateFormulaUrlAndSha(SIMPLE_FORMULA, NEW_URL, NEW_SHA);
		expect(result).toContain(`url "${NEW_URL}"`);
		expect(result).toContain(`sha256 "${NEW_SHA}"`);
		expect(result).not.toContain("v0.1.10");
		expect(result).not.toContain("aaaa");
	});

	test("only updates the url-paired sha256, not bottle sha256 lines", () => {
		const result = updateFormulaUrlAndSha(FORMULA_WITH_BOTTLE, NEW_URL, NEW_SHA);
		expect(result).toContain(`sha256 "${NEW_SHA}"`);
		expect(result).toContain("bbbbbbbb");
		expect(result).toContain("cccccccc");
	});

	test("only updates the main url+sha, not resource block url+sha", () => {
		const result = updateFormulaUrlAndSha(FORMULA_WITH_RESOURCE, NEW_URL, NEW_SHA);
		expect(result).toContain(`url "${NEW_URL}"`);
		expect(result).toContain(`sha256 "${NEW_SHA}"`);
		expect(result).toContain("dddddddd");
		expect(result).toContain("https://example.com/helper-1.0.tar.gz");
	});

	test("matches release-asset URLs (releases/download/)", () => {
		const result = updateFormulaUrlAndSha(RELEASE_ASSET_FORMULA, NEW_URL, NEW_SHA);
		expect(result).toContain(`url "${NEW_URL}"`);
		expect(result).toContain(`sha256 "${NEW_SHA}"`);
		expect(result).not.toContain("releases/download/v0.1.10");
	});

	test("throws when url pattern does not match", () => {
		const nonGithubFormula = `class Foo < Formula
  url "https://example.com/foo-1.0.tar.gz"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
end
`;
		expect(() => updateFormulaUrlAndSha(nonGithubFormula, NEW_URL, NEW_SHA)).toThrow(
			/could not find paired url \+ sha256/,
		);
	});

	test("throws when sha256 is not on the line following url", () => {
		const gappedFormula = `class Foo < Formula
  url "https://github.com/lacymorrow/shipx/archive/refs/tags/v0.1.10.tar.gz"
  license "MIT"
  sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
end
`;
		expect(() => updateFormulaUrlAndSha(gappedFormula, NEW_URL, NEW_SHA)).toThrow(
			/could not find paired url \+ sha256/,
		);
	});

	test("preserves surrounding whitespace and indentation", () => {
		const result = updateFormulaUrlAndSha(SIMPLE_FORMULA, NEW_URL, NEW_SHA);
		const lines = result.split("\n");
		const urlLine = lines.find((l) => l.includes("url "));
		const shaLine = lines.find((l) => l.includes("sha256 ") && !l.includes("cellar"));
		expect(urlLine).toStartWith("  ");
		expect(shaLine).toStartWith("  ");
	});

	test("matches uppercase hex sha256", () => {
		const upperFormula = `class Shipx < Formula
  url "https://github.com/lacymorrow/shipx/archive/refs/tags/v0.1.10.tar.gz"
  sha256 "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
end
`;
		const result = updateFormulaUrlAndSha(upperFormula, NEW_URL, NEW_SHA);
		expect(result).toContain(`url "${NEW_URL}"`);
		expect(result).toContain(`sha256 "${NEW_SHA}"`);
		expect(result).not.toContain("AAAA");
	});

	test("does not interpret $ in newUrl/newSha as regex backreferences", () => {
		// If escapeReplacement is missing, `$1` in the replacement string would
		// resolve to the first captured group instead of the literal "$1".
		const trickyUrl =
			"https://github.com/lacymorrow/shipx/archive/refs/tags/v0.1.11$1$&.tar.gz";
		const trickySha = "$1$&11111111111111111111111111111111111111111111111111111111111111";
		const result = updateFormulaUrlAndSha(SIMPLE_FORMULA, trickyUrl, trickySha);
		expect(result).toContain(`url "${trickyUrl}"`);
		expect(result).toContain(`sha256 "${trickySha}"`);
	});
});

const BINARY_FORMULA = `class Lash < Formula
  desc "AI shell"
  homepage "https://github.com/lacymorrow/lash"
  license "MIT"

  on_macos do
    if Hardware::CPU.intel?
      url "https://github.com/lacymorrow/lash/releases/download/v0.1.0/lashcode-darwin-x64.zip"
      sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    end
    if Hardware::CPU.arm?
      url "https://github.com/lacymorrow/lash/releases/download/v0.1.0/lashcode-darwin-arm64.zip"
      sha256 "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    end
  end

  on_linux do
    if Hardware::CPU.intel?
      url "https://github.com/lacymorrow/lash/releases/download/v0.1.0/lashcode-linux-x64.tar.gz"
      sha256 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    end
    if Hardware::CPU.arm?
      url "https://github.com/lacymorrow/lash/releases/download/v0.1.0/lashcode-linux-arm64.tar.gz"
      sha256 "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    end
  end
end
`;

describe("updateBinaryFormulaAssets", () => {
	test("updates all four platform url+sha pairs", () => {
		const assets = {
			"darwin-x64": {
				url: "https://github.com/lacymorrow/lash/releases/download/v0.2.0/lashcode-darwin-x64.zip",
				sha256: "1111111111111111111111111111111111111111111111111111111111111111",
			},
			"darwin-arm64": {
				url: "https://github.com/lacymorrow/lash/releases/download/v0.2.0/lashcode-darwin-arm64.zip",
				sha256: "2222222222222222222222222222222222222222222222222222222222222222",
			},
			"linux-x64": {
				url: "https://github.com/lacymorrow/lash/releases/download/v0.2.0/lashcode-linux-x64.tar.gz",
				sha256: "3333333333333333333333333333333333333333333333333333333333333333",
			},
			"linux-arm64": {
				url: "https://github.com/lacymorrow/lash/releases/download/v0.2.0/lashcode-linux-arm64.tar.gz",
				sha256: "4444444444444444444444444444444444444444444444444444444444444444",
			},
		};

		const { formula, updatedPlatforms, unmatchedPlatforms } = updateBinaryFormulaAssets(BINARY_FORMULA, assets);

		expect(formula).toContain(assets["darwin-x64"].url);
		expect(formula).toContain(assets["darwin-x64"].sha256);
		expect(formula).toContain(assets["darwin-arm64"].url);
		expect(formula).toContain(assets["darwin-arm64"].sha256);
		expect(formula).toContain(assets["linux-x64"].url);
		expect(formula).toContain(assets["linux-x64"].sha256);
		expect(formula).toContain(assets["linux-arm64"].url);
		expect(formula).toContain(assets["linux-arm64"].sha256);

		expect(formula).not.toContain("v0.1.0");
		expect(formula).not.toContain("aaaa");
		expect(formula).not.toContain("bbbb");
		expect(formula).not.toContain("cccc");
		expect(formula).not.toContain("dddd");

		expect(updatedPlatforms).toHaveLength(4);
		expect(unmatchedPlatforms).toHaveLength(0);
	});

	test("updates a subset of platforms and reports unmatched", () => {
		const assets = {
			"darwin-arm64": {
				url: "https://github.com/lacymorrow/lash/releases/download/v0.2.0/lashcode-darwin-arm64.zip",
				sha256: "2222222222222222222222222222222222222222222222222222222222222222",
			},
		};

		const { formula, updatedPlatforms, unmatchedPlatforms } = updateBinaryFormulaAssets(BINARY_FORMULA, assets);

		expect(formula).toContain(assets["darwin-arm64"].url);
		expect(formula).toContain(assets["darwin-arm64"].sha256);
		expect(formula).toContain("lashcode-darwin-x64.zip");
		expect(formula).toContain("aaaaaaa");

		expect(updatedPlatforms).toEqual(["darwin-arm64"]);
		expect(unmatchedPlatforms).toHaveLength(0);
	});

	test("throws when no platform blocks match", () => {
		expect(() =>
			updateBinaryFormulaAssets(SIMPLE_FORMULA, {
				"darwin-arm64": {
					url: "https://example.com/foo.zip",
					sha256: "1111111111111111111111111111111111111111111111111111111111111111",
				},
			}),
		).toThrow(/could not find any platform-conditional/);
	});

	test("throws on unknown platform keys", () => {
		expect(() =>
			updateBinaryFormulaAssets(BINARY_FORMULA, {
				"darwin-arm": {
					url: "https://example.com/foo.zip",
					sha256: "1111111111111111111111111111111111111111111111111111111111111111",
				},
			}),
		).toThrow(/Unknown binary asset platform/);
	});

	test("preserves formula structure outside url+sha pairs", () => {
		const assets = {
			"darwin-x64": {
				url: "https://example.com/new.zip",
				sha256: "1111111111111111111111111111111111111111111111111111111111111111",
			},
		};

		const { formula } = updateBinaryFormulaAssets(BINARY_FORMULA, assets);

		expect(formula).toContain('desc "AI shell"');
		expect(formula).toContain("on_macos do");
		expect(formula).toContain("on_linux do");
		expect(formula).toContain("Hardware::CPU.intel?");
		expect(formula).toContain("Hardware::CPU.arm?");
	});
});
