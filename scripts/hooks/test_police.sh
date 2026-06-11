#!/bin/bash

# Test Police Hook (Veto Loop Demo)
# This hook checks if Go files were edited without accompanying tests.

modified_files=$(git diff --name-only HEAD)
go_files=$(echo "$modified_files" | grep "\.go$" | grep -v "_test\.go$")
test_files=$(echo "$modified_files" | grep "_test\.go$")

if [ -n "$go_files" ] && [ -z "$test_files" ]; then
  echo "⚠️ TEST POLICE VETO!"
  echo "You modified Go files but didn't add/update any tests."
  echo "Modified files: $go_files"
  echo "Please create a test before finishing."
  exit 2 # TRIGGER VETO (Agent MUST continue)
fi

exit 0
