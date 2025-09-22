#!/bin/bash

# Local development and testing script for Al Ummah Now Auth

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Al Ummah Now Auth - Development Script${NC}"
echo "=================================================="

# Function to print status
print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    print_error "Wrangler CLI not found. Installing..."
    npm install -g wrangler
fi

# Parse command line arguments
COMMAND=${1:-"help"}

case $COMMAND in
    "install")
        echo -e "${BLUE}📦 Installing dependencies...${NC}"
        npm install
        print_status "Dependencies installed"
        ;;
        
    "test")
        echo -e "${BLUE}🧪 Running tests...${NC}"
        npm run check
        node test-user-management.js
        print_status "Tests completed"
        ;;
        
    "dev")
        echo -e "${BLUE}🔧 Starting development server...${NC}"
        echo "Preview URL will be: http://localhost:8787"
        echo "Admin panel: http://localhost:8787/admin"
        npm run dev
        ;;
        
    "deploy")
        echo -e "${BLUE}🚀 Deploying to production...${NC}"
        print_warning "This will deploy to production. Are you sure? (y/N)"
        read -r confirm
        if [[ $confirm =~ ^[Yy]$ ]]; then
            npm run deploy
            print_status "Production deployment completed"
        else
            print_warning "Production deployment cancelled"
        fi
        ;;
        
    "migrate")
        echo -e "${BLUE}🗃️  Running migrations...${NC}"
        wrangler d1 migrations apply AUTH_DB --remote
        print_status "Migrations completed"
        ;;
        
    "logs")
        echo -e "${BLUE}📋 Tailing logs...${NC}"
        wrangler tail
        ;;
        
    "status")
        echo -e "${BLUE}📊 Checking deployment status...${NC}"
        echo
        echo "Production:"
        echo "  URL: https://al-ummah-now-auth.alummahnow.workers.dev"
        echo "  Admin: https://al-ummah-now-auth.alummahnow.workers.dev/admin"
        echo
        wrangler deployments list 2>/dev/null | head -5 || print_warning "Could not fetch deployments"
        ;;
        
    "clean")
        echo -e "${BLUE}🧹 Cleaning up...${NC}"
        rm -rf node_modules
        rm -f package-lock.json
        print_status "Cleanup completed. Run './dev.sh install' to reinstall dependencies"
        ;;
        
    "help"|*)
        echo -e "${BLUE}Available commands:${NC}"
        echo
        echo "  install         - Install dependencies"
        echo "  test           - Run tests and validation"
        echo "  dev            - Start local development server"
        echo "  deploy         - Deploy to production (with confirmation)"
        echo "  migrate        - Run database migrations"
        echo "  logs           - Tail logs from production"
        echo "  status         - Show deployment status and URLs"
        echo "  clean          - Clean node_modules and package-lock.json"
        echo "  help           - Show this help message"
        echo
        echo -e "${YELLOW}Examples:${NC}"
        echo "  ./dev.sh install"
        echo "  ./dev.sh test"
        echo "  ./dev.sh dev"
        echo "  ./dev.sh deploy"
        echo "  ./dev.sh migrate"
        echo "  ./dev.sh logs"
        ;;
esac