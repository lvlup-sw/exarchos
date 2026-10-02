/**
 * @fileoverview Tests for comment extraction from shell, YAML and PowerShell files.
 */
import { describe, it, expect } from 'vitest';
import { sourceBlocks, sourceLanguage } from '../../../tools/audit/lib/comment-sources.mjs';

/** The prose of each block, for compact assertions. */
function texts(relPath: string, text: string): string[] {
  return sourceBlocks(relPath, text).map((b) => b.text);
}

describe('shell comments', () => {
  it('Shell_OwnLineComments_MergeAndShebangIsSkipped', () => {
    expect(texts('a.sh', '#!/usr/bin/env bash\n# one\n# two\necho hi\n')).toEqual(['one two']);
  });

  it('Shell_HashInsideQuotesAndExpansions_IsNotAComment', () => {
    const source = 'echo "# no" \'# no\'\nx=${y#pre}\nn=$#\nz=$(( 16#ff ))\necho done # yes\n';

    expect(texts('a.sh', source)).toEqual(['yes']);
  });

  it('Shell_HeredocBody_IsSkippedEvenWithAnApostrophe', () => {
    const source = "cat <<EOF\nit's # not a comment\nEOF\n# after the heredoc\n";

    expect(texts('a.sh', source)).toEqual(['after the heredoc']);
  });

  it('Shell_IndentedHeredocWithQuotedDelimiter_IsSkipped', () => {
    const source = "cat <<-'END'\n\t# body\n\tEND\n# real\n";

    expect(texts('a.sh', source)).toEqual(['real']);
  });

  it('Shell_UnclosedHeredoc_DoesNotHideTheRestOfTheFile', () => {
    expect(texts('a.sh', 'x=$(( a << b ))\n# still read\n')).toEqual(['still read']);
  });

  it('Shell_ShellcheckDirective_IsSkipped', () => {
    expect(texts('a.sh', '# shellcheck disable=SC2086\n# prose\n')).toEqual(['prose']);
  });
});

describe('YAML comments', () => {
  it('Yaml_CommentsAndRunBlockShellComments_AreRead', () => {
    const source = '# top\njobs:\n  a:\n    steps:\n      - run: |\n          echo hi # shell trailing\n      - name: x # yaml trailing\n';

    expect(texts('w.yml', source)).toEqual(['top', 'shell trailing', 'yaml trailing']);
  });

  it('Yaml_HashInsideAPlainOrQuotedScalar_IsNotAComment', () => {
    expect(texts('w.yaml', 'a: "x # y"\nb: |\n  # markdown heading\n')).toEqual([]);
  });

  it('Yaml_RunBlockLines_KeepTheirFileLineNumbers', () => {
    const blocks = sourceBlocks('w.yml', 'steps:\n  - run: |\n      echo hi\n      # shell note\n');

    expect(blocks.map((b) => [b.line, b.text])).toEqual([[4, 'shell note']]);
  });
});

describe('PowerShell comments', () => {
  it('PowerShell_LineBlockAndHereString_AreHandled', () => {
    const source = '#requires -Version 7\n<#\n.SYNOPSIS\n  Install it\n#>\n$a = "# no" # yes\n$h = @"\n# not\n"@\n';

    expect(texts('a.ps1', source)).toEqual(['.SYNOPSIS Install it', 'yes']);
  });
});

describe('sourceLanguage', () => {
  it('SourceLanguage_MapsExtensions', () => {
    expect([sourceLanguage('a.sh'), sourceLanguage('a.yaml'), sourceLanguage('a.ps1'), sourceLanguage('a.ts')]).toEqual([
      'shell',
      'yaml',
      'powershell',
      undefined,
    ]);
  });
});
