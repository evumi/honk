#!/bin/sh
# Fails unless the generated entitlements carry every permission the app and
# its extension need. XcodeGen rewrites these files on each run; with
# `entitlements.path` but no `properties` it writes an empty dict, which
# silently breaks push, the App Group and the shared keychain.
set -eu
cd "$(dirname "$0")/../ios"
status=0

check() { # file key expected-value-or-empty
  file=$1 key=$2 want=$3
  if ! got=$(/usr/libexec/PlistBuddy -c "Print :$key" "$file" 2>/dev/null); then
    echo "error: $file is missing $key" >&2
    status=1
    return
  fi
  if [ -n "$want" ] && ! printf '%s' "$got" | grep -qF -- "$want"; then
    echo "error: $file $key is '$got', want it to contain '$want'" >&2
    status=1
  fi
}

app=App/Honk.entitlements
ext=NotificationService/NotificationService.entitlements
check $app aps-environment '$(APS_ENVIRONMENT)'
check $app com.apple.security.application-groups '$(HONK_APP_GROUP)'
check $app keychain-access-groups '$(AppIdentifierPrefix)$(HONK_KEYCHAIN_GROUP)'
check $app com.apple.developer.usernotifications.communication true
check $app com.apple.developer.usernotifications.time-sensitive true
check $ext com.apple.security.application-groups '$(HONK_APP_GROUP)'
check $ext keychain-access-groups '$(AppIdentifierPrefix)$(HONK_KEYCHAIN_GROUP)'

[ $status -eq 0 ] && echo "entitlements ok"
exit $status
