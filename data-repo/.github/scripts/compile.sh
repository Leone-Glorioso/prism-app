#!/usr/bin/env bash
# Compile one project listed in prism-projects.json and write the results to an output folder.
# Usage: compile.sh "<Project name>" <output dir>
# Writes <output dir>/output.pdf (if produced), output.log, result.json. Always exits 0 once
# result.json is written, so the workflow can publish logs of failed builds too.
set -uo pipefail

project="${1:?project name required}"
out="${2:?output dir required}"
timeout_s="${COMPILE_TIMEOUT_SECONDS:-1800}"
manifest="prism-projects.json"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
repo_root="$(pwd)"
CMD_STR=""

write_result() { # status exit_code main_file engine first_error duration
  STATUS="$1" EXIT_CODE="$2" MAIN_FILE="$3" ENGINE="$4" FIRST_ERROR="$5" DURATION="$6" \
  PROJECT="$project" SHA="${GITHUB_SHA:-}" RUN_ID="${GITHUB_RUN_ID:-}" COMMAND="$CMD_STR" IMAGE="${TEXLIVE_IMAGE:-}" \
  perl -MJSON::PP -e '
    my %r = map { $_ => $ENV{uc $_} } qw(status project main_file engine first_error sha run_id command image);
    $r{exit_code} = $ENV{EXIT_CODE} + 0; $r{duration_seconds} = $ENV{DURATION} + 0;
    my @t = gmtime; $r{finished_at} = sprintf("%04d-%02d-%02dT%02d:%02d:%02dZ", $t[5]+1900, $t[4]+1, @t[3,2,1,0]);
    print JSON::PP->new->canonical->pretty->encode(\%r);' > "$out/result.json"
}

# Look up the project. Bytes in, bytes out, so non-ASCII names compare correctly.
entry="$(PROJECT="$project" perl -MJSON::PP -e '
  local $/; open my $f, "<:raw", $ARGV[0] or exit 2; my $raw = <$f>; $raw =~ s/^\xEF\xBB\xBF//;
  my $list = eval { JSON::PP->new->decode($raw) }; exit 2 unless ref $list eq "ARRAY";
  for my $p (@$list) {
    next unless $p->{Project} eq $ENV{PROJECT};
    (my $m = $p->{MainFile} // "") =~ s{\\}{/}g;
    # Extra latexmk options are passed as separate words (never through a shell); only plain characters are allowed.
    my $extra = $p->{LatexmkArgs} // "";
    exit 6 if length($extra) > 300 || $extra !~ m{\A[A-Za-z0-9 _=.,:+/@%-]*\z};
    # main file, engine, shell escape (0/1), project latexmkrc (0/1), clean build (0/1), extra options
    print join("\t", $m, lc($p->{Engine} // "pdflatex"), ($p->{ShellEscape} ? 1 : 0), ($p->{UseLatexmkrc} ? 1 : 0), ($p->{CleanBuild} ? 1 : 0), $extra); exit 0;
  }
  exit 3;' "$manifest")"
case $? in
  0) ;;
  2) echo "Cannot read or parse $manifest" > "$out/output.log"; write_result error 2 "" "" "Cannot read or parse $manifest" 0; exit 0 ;;
  6) echo "Invalid extra latexmk options for $project" > "$out/output.log"; write_result error 6 "" "" "Invalid extra latexmk options (allowed: letters, digits, space and _ = . , : + / @ % -)" 0; exit 0 ;;
  *) echo "Project not in $manifest: $project" > "$out/output.log"; write_result error 3 "" "" "Project not in manifest" 0; exit 0 ;;
esac
IFS=$'\t' read -r main engine shellflag rcflag cleanflag extra_str <<< "$entry"

# Trust boundary: the project name comes from a workflow input.
if [[ -z "$main" || "$main" == /* || "$main" == *".."* || "$main" != "$project/"* || ! -f "$main" ]]; then
  echo "Main file missing or outside the project: '$main'" > "$out/output.log"
  write_result error 4 "$main" "$engine" "Main file missing: $main" 0; exit 0
fi
case "$engine" in
  pdflatex) flag=-pdf ;; xelatex) flag=-xelatex ;; lualatex) flag=-lualatex ;;
  *) echo "Unsupported engine: $engine" > "$out/output.log"; write_result error 5 "$main" "$engine" "Unsupported engine: $engine" 0; exit 0 ;;
esac

dir="$(dirname "$main")"
base="$(basename "$main" .tex)"
start=$(date +%s)
cd "$dir"
# -f: keep going after errors so a PDF is still produced when possible (as Prism did).
# Default: -norc (ignore latexmkrc files from the repo) and TeX Live's restricted shell escape.
# Per project, the manifest can switch on full shell escape (minted, pythontex, svg...) and the project's own
# latexmkrc (glossaries, nomenclature, custom steps). Both run only inside the throw-away container
# (no network, no privileges, no secrets), so the project's code cannot reach anything outside it.
rcargs=()
[[ "$rcflag" == 1 ]] || rcargs=(-norc)
args=("${rcargs[@]}" -f -interaction=nonstopmode -file-line-error -synctex=1 "$flag")
[[ "$shellflag" == 1 ]] && args+=(-shell-escape)
extra=()
[[ -n "${extra_str:-}" ]] && read -r -a extra <<< "$extra_str"
[[ ${#extra[@]} -gt 0 ]] && args+=("${extra[@]}")
CMD_STR="latexmk ${args[*]} $base.tex"
# Clean build: remove every generated file first, so stale auxiliary files cannot cause trouble.
if [[ "$cleanflag" == 1 ]]; then
  latexmk "${rcargs[@]}" -C "$base.tex" > "$out/clean.txt" 2>&1 || true
  rm -f "$out/clean.txt"
fi
timeout "$timeout_s" latexmk "${args[@]}" "$base.tex" > "$out/latexmk.txt" 2>&1
code=$?
duration=$(( $(date +%s) - start ))

if [[ -f "$base.log" ]]; then cp "$base.log" "$out/output.log"; else cp "$out/latexmk.txt" "$out/output.log"; fi
[[ -f "$base.pdf" ]] && cp "$base.pdf" "$out/output.pdf"
[[ -f "$base.synctex.gz" ]] && cp "$base.synctex.gz" "$out/output.synctex.gz"

first_error="$(grep -m1 -E '^(! |[^ :]+:[0-9]+: )' "$out/output.log" || true)"
if [[ $code -eq 124 ]]; then status=timeout; first_error="Compile exceeded ${timeout_s}s"
elif [[ $code -eq 0 && -f "$out/output.pdf" ]]; then status=ok
elif [[ -f "$out/output.pdf" ]]; then status=warning   # PDF produced despite errors
else status=error; [[ -z "$first_error" ]] && first_error="$(tail -n 5 "$out/latexmk.txt" | tr '\n' ' ')"
fi
cd "$repo_root"
write_result "$status" "$code" "$main" "$engine" "$first_error" "$duration"
echo "Result: $status (latexmk exit $code, ${duration}s)"
exit 0
