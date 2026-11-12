#!/bin/bash
# Plan step 7-8 verification: every tier logs in, sees only its own subtree, and
# cannot reach controller-only pages. Ends with the two cascade rules.
set -u
B=http://localhost:3000
T=$(cygpath -w /tmp)
export T
cd "$(dirname "$0")/.." || exit 1

TP_PASS=tier12345
login() { rm -f "$T/j_$1.txt"; curl -s -c "$T/j_$1.txt" -o /dev/null -w "%{redirect_url}" -X POST -d "username=$2&password=$3" $B/login; }
code() { curl -s -b "$T/j_$1.txt" -o "$T/page_$1_$(basename "$2").html" -w "%{http_code}" "$B$2"; }
signed_in() { [ "$(code $1 /home)" = "200" ]; }
# /add_user takes its parent from the session, and a panel may only create the
# role directly below it, which is why the two temp panels are made one after the
# other rather than both from YOGIMASTER.
make_panel() { curl -s -b "$T/j_$1.txt" -o /dev/null -X POST -d "user_name=$2&password=$TP_PASS&role=$3" $B/add_user; }
panel_id() { node -e "const s=require('./db');const id=s.scalar(\"SELECT id FROM users WHERE username = '$1'\");console.log(id ? id : '')"; }

# check_scope.js reads the pages written below, so yesterday's fixtures must not
# be allowed to speak for today's database.
rm -f "$T"/page_*.html

# Two of the seeded accounts (YOGIADMIN, YOGISUPERSELLER) have passwords the owner
# changed, so nothing here signs in as them. The admin and super seller tiers are
# instead walked with two throwaway panels made under the demo chain: this suite
# never resets a password to make a check pass, and it never leaves a panel behind.
# They are created before any page is fetched, because their ancestors' subtrees
# have to include them in the pages being measured.
echo "=== 0. two temporary panels for the tiers the owner re-keyed"
login YOGIMASTER YOGIMASTER demo123 > /dev/null
if signed_in YOGIMASTER; then
  rm -f "$T/page_YOGIMASTER_home.html"
  login TPADM TPADM "$TP_PASS" > /dev/null
  if ! signed_in TPADM; then
    make_panel YOGIMASTER TPADM admin
    login TPADM TPADM "$TP_PASS" > /dev/null
  fi
  login TPSUP TPSUP "$TP_PASS" > /dev/null
  if ! signed_in TPSUP; then
    make_panel TPADM TPSUP super_seller
    login TPSUP TPSUP "$TP_PASS" > /dev/null
  fi
  rm -f "$T/page_TPADM_home.html" "$T/page_TPSUP_home.html"
  echo "  TPADM/TPSUP ready: $( [ -n "$(panel_id TPADM)" ] && echo yes || echo no ) / $( [ -n "$(panel_id TPSUP)" ] && echo yes || echo no )"
else
  echo "  YOGIMASTER did not sign in, so the temp panels were not made; those two tiers will be skipped"
fi

echo
echo "=== 1. login + page walk per tier"
ALL_PAGES="/home /all_user /all_developer_panels /all_super_master_admins /all_master_admins /all_admins /all_super_sellers /all_seller /all_key /transaction /news /reports /set_price /token_stats /today_result /top_result /add_user /api/nope"

for who in admin LUCKYDEV LUCKYSUPERMASTER YOGIMASTER TPADM TPSUP YOGISELL; do
  case "$who" in
    admin) pw=admin123 ;;
    TPADM|TPSUP) pw="$TP_PASS" ;;
    *) pw=demo123 ;;
  esac
  login $who $who "$pw" > /dev/null
  # The honest test for a session is a page only a signed-in panel can serve.
  if ! signed_in $who; then
    # That probe wrote a fixture full of redirect markup; check_scope.js must not
    # read it as a page this account was served.
    rm -f "$T/page_${who}_home.html"
    printf '%-17s skipped (not signed in)\n' "$who"
    continue
  fi
  printf '%-17s' "$who home=200"
  for p in $ALL_PAGES; do
    [ "$p" = "/home" ] && continue
    printf ' %s=%s' "$(basename "$p")" "$(code $who "$p")"
  done
  echo
done

echo
echo "=== 2. subtree scoping"
node scripts/check_scope.js
SCOPE=$?

echo
echo "=== 3. cascade rules"
node scripts/check_cascades.js
CASCADE=$?

echo
echo "=== 4. the temporary panels leave the database"
if [ -n "$(panel_id TPADM)" ]; then
  # Deleting accounts is the controller's alone (Final Delete Permission Rule),
  # so the controller jar from the page walk removes the temp branch.
  curl -s -b "$T/j_admin.txt" -o /dev/null -X POST -d "root_id=$(panel_id TPADM)" $B/delete_user_cascade
fi
LEFT=$(node -e "const s=require('./db');console.log(s.scalar(\"SELECT COUNT(*) FROM users WHERE username IN ('TPADM','TPSUP')\"))")
echo "  leftover temp panels: $LEFT"

[ "$SCOPE" = 0 ] || exit 1
[ "$CASCADE" = 0 ] || exit 1
[ "$LEFT" = 0 ] || exit 1
