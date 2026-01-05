#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Shared Logging Utilities
# Source this file to use consistent logging across azd hook scripts
# -----------------------------------------------------------------------------

# Colors for output
readonly LOG_RED='\033[0;31m'
readonly LOG_GREEN='\033[0;32m'
readonly LOG_YELLOW='\033[1;33m'
readonly LOG_BLUE='\033[0;34m'
readonly LOG_NC='\033[0m' # No Color

log_info() {
    echo -e "${LOG_BLUE}[INFO]${LOG_NC} $1"
}

log_success() {
    echo -e "${LOG_GREEN}[SUCCESS]${LOG_NC} $1"
}

log_warning() {
    echo -e "${LOG_YELLOW}[WARNING]${LOG_NC} $1"
}

log_error() {
    echo -e "${LOG_RED}[ERROR]${LOG_NC} $1" >&2
}
