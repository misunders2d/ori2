#!/bin/bash
set -e

echo "============================================="
echo "   Installing Ori Platform...                "
echo "============================================="

# Ensure Node is installed
if ! command -v node &> /dev/null
then
    echo "❌ Node.js could not be found. Please install Node.js (v18+) first."
    exit 1
fi

# Install dependencies if not already installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install --silent
fi

echo "🚀 Launching..."
# Using exec to replace the bash process with node, handling signals properly
exec npm run start
