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

write_result() { # status exit_code main_file engine first_error duration
  STATUS="$1" EXIT_CODE="$2" MAIN_FILE="$3" ENGINE="$4" FIRST_ERROR="$5" DURATION="$6" \
  PROJECT="$project" SHA="${GITHUB_SHA:-}" RUN_ID="${GITHUB_RUN_ID:-}" \
  perl -MJSON::PP -e '
    my %r = map { $_ => $ENV{uc $_} } qw(status project main_file engine first_error sha run_id);
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
    print "$m\t", lc($p->{Engine} // "pdflatex"); exit 0;
  }
  exit 3;' "$manifest")"
case $? in
  0) ;;
  2) echo "Cannot read or parse $manifest" > "$out/output.log"; write_result error 2 "" "" "Cannot read or parse $manifest" 0; exit 0 ;;
  *) echo "Project not in $manifest: $project" > "$out/output.log"; write_result error 3 "" "" "Project not in manifest" 0; exit 0 ;;
esac
main="${entry%%$'\t'*}"
engine="${entry#*$'\t'}"

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
# -norc: ignore latexmkrc files from the repo; shell escape stays at the TeX Live default (restricted).
timeout "$timeout_s" latexmk -norc "$flag" -f -interaction=nonstopmode -file-line-error -synctex=1 "$base.tex" \
  > "$out/latexmk.txt" 2>&1
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
