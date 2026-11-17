# Executed as fixed shell text by isolation-probe.js. All paths are fixtures.
set -eu
credential=$1 foreign=$2 allowed=$3 symlink=$4 hardlink=$5 late=$6 service=$7 approval=$8 task=$9
shift 9
pid=$1 home=$2 codex=$3
printf 'READY\n'
IFS= read -r instruction
[ "$instruction" = continue ]
readable() {
    if (IFS= read -r unused < "$1" || [ -n "$unused" ]) 2>/dev/null; then
        printf true
    else
        printf false
    fi
}
writable() {
    if (printf DISPOSABLE_WRITE > "$1") 2>/dev/null; then
        printf true
    else
        printf false
    fi
}
sanitized=false
if [ -z "${TELEGRAM_BOT_TOKEN+x}${MAILBOX_TOKEN+x}${GOOGLE_MAPS_API_KEY+x}${ASSISTANT_CAPABILITY+x}${PROBE_AMBIENT_CANARY+x}${PYTHONPATH+x}" ] &&
    { [ -z "${HOME:-}" ] || [ "$HOME" = "$home" ]; } &&
    { [ -z "${CODEX_HOME:-}" ] || [ "$CODEX_HOME" = "$codex" ]; }; then
    sanitized=true
fi
arg=false
if /bin/ps -p "$pid" -o command= 2>/dev/null | /bin/grep -q DISPOSABLE_PROCESS_ARG_CANARY; then
    arg=true
fi
printf '{"allowedInputReadable":%s,"credentialReadable":%s,"foreignTaskReadable":%s,"symlinkReadable":%s,"hardlinkReadable":%s,"lateForeignReadable":%s,"serviceReadable":%s,"approvalReadable":%s,' "$(readable "$allowed")" "$(readable "$credential")" "$(readable "$foreign")" "$(readable "$symlink")" "$(readable "$hardlink")" "$(readable "$late")" "$(readable "$service")" "$(readable "$approval")"
printf '"taskWritable":%s,"symlinkWritable":%s,"hardlinkWritable":%s,"lateForeignWritable":%s,"foreignWritable":%s,"credentialWritable":%s,"serviceWritable":%s,"approvalWritable":%s,"childEnvSanitized":%s,"foreignArgReadable":%s}\n' "$(writable "$task")" "$(writable "$symlink")" "$(writable "$hardlink")" "$(writable "$late")" "$(writable "$foreign")" "$(writable "$credential")" "$(writable "$service")" "$(writable "$approval")" "$sanitized" "$arg"
