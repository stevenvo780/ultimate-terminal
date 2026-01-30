#!/bin/bash

BASE_URL="http://localhost:54321/api"
ADMIN_USER="admin"
ADMIN_PASSWORD="dev-change-me"

echo "1. Attempting login as admin..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"$ADMIN_USER\", \"password\": \"$ADMIN_PASSWORD\"}")

echo "Response: $LOGIN_RESPONSE"
TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "❌ Login Failed!"
  exit 1
else
  echo "✅ Login Successful! Token: ${TOKEN:0:15}..."
fi

echo ""
echo "2. Listing workers..."
WORKERS_RESPONSE=$(curl -s -X GET "$BASE_URL/workers" \
  -H "Authorization: Bearer $TOKEN")

echo "Response: $WORKERS_RESPONSE"

if [[ "$WORKERS_RESPONSE" == *"Docker-Dev-Worker"* ]]; then
  echo "✅ Worker 'Docker-Dev-Worker' found in list!"
else
  echo "❌ Worker not found or list failed."
  exit 1
fi

echo ""
echo "🎉 Auth flow test passed!"
