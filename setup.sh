#!/bin/bash

# Diffract Setup Script - Automated NemoClaw Installation from Local Git Repo
# This script automates all steps from diffract.md for WSL2 environment

set -e  # Exit on any error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo -e "\n${BLUE}=== $1 ===${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

# Step 0: Uninstall existing NemoClaw if present
print_header "Checking for Existing NemoClaw Installation"

if command -v nemoclaw &> /dev/null; then
    NEMOCLAW_PATH=$(which nemoclaw)
    print_warning "Found existing nemoclaw at: $NEMOCLAW_PATH"
    print_warning "Uninstalling existing global nemoclaw..."
    npm uninstall -g nemoclaw 2>/dev/null || true
    
    # Also remove the binary directly if it still exists
    if [ -f "$NEMOCLAW_PATH" ]; then
        rm -f "$NEMOCLAW_PATH"
        print_warning "Removed binary at: $NEMOCLAW_PATH"
    fi
    
    print_success "Existing nemoclaw uninstalled"
else
    print_success "No existing nemoclaw installation found"
fi

# Verify it's gone
if command -v nemoclaw &> /dev/null; then
    print_warning "nemoclaw still found, attempting to remove: $(which nemoclaw)"
    rm -f "$(which nemoclaw)"
fi

# Final check
if command -v nemoclaw &> /dev/null; then
    print_error "Failed to uninstall existing nemoclaw at: $(which nemoclaw)"
    exit 1
fi

# Step 1: Verify prerequisites
print_header "Verifying Prerequisites"

if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed or not in PATH"
    print_warning "Please ensure Docker Desktop is running with WSL2 Integration enabled"
    exit 1
fi

if ! docker ps &> /dev/null; then
    print_error "Docker daemon is not responding"
    print_warning "Please start Docker Desktop and ensure WSL2 Integration is enabled"
    exit 1
fi

print_success "Docker is running"

# Step 1: Install OpenShell Runtime
print_header "Step 1: Installing OpenShell Runtime"

if command -v openshell &> /dev/null; then
    print_success "OpenShell is already installed"
else
    print_warning "Installing OpenShell..."
    curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
    source ~/.bashrc
    print_success "OpenShell installed successfully"
fi

# Step 2: Navigate to NemoClaw directory
print_header "Step 2: Navigating to NemoClaw Directory"

NEMOCLAW_DIR="NemoClaw"

if [ ! -d "$NEMOCLAW_DIR" ]; then
    print_error "NemoClaw directory not found at: $NEMOCLAW_DIR"
    print_warning "Please update the NEMOCLAW_DIR variable in this script"
    exit 1
fi

cd "$NEMOCLAW_DIR"
print_success "Changed to NemoClaw directory: $(pwd)"

# Step 3: Install Dependencies & Build CLI
print_header "Step 3: Installing Dependencies & Building CLI"

print_warning "Installing latest version of npm..."
npm install -g npm@latest
print_success "npm updated to latest version"

print_warning "Installing npm dependencies..."
npm install
print_success "Dependencies installed"

print_warning "Compiling TypeScript to JavaScript..."
npm run build:cli
print_success "CLI built successfully"

# Step 4: Install Local Build Globally
print_header "Step 4: Installing Local Build Globally"

print_warning "Installing NemoClaw CLI globally from local directory..."
npm install -g .
print_success "NemoClaw CLI installed globally"

# Verification Steps
print_header "Verification & Bootstrapping"

# Step 1: Verify command points to repo
print_warning "Verifying nemoclaw command location..."
NEMOCLAW_PATH=$(which nemoclaw)
print_success "nemoclaw command found at: $NEMOCLAW_PATH"

# Step 2: Optional - Run onboarding
print_header "Setup Complete!"
echo -e "${GREEN}All installation steps completed successfully!${NC}\n"

echo "Next steps:"
echo "1. Run the onboarding wizard:"
echo -e "   ${BLUE}nemoclaw onboard${NC}"
echo ""
echo "2. Connect to your sandbox:"
echo -e "   ${BLUE}nemoclaw nemoclaw-sandbox connect${NC}"
echo ""
echo "Troubleshooting tips:"
echo "- If TypeScript compilation fails, run: npm run typecheck"
echo "- If Docker issues occur, verify: docker ps"
echo "- For active development, use: npm link (instead of npm install -g .)"
echo ""
