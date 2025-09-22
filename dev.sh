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
        
    "dev:preview")
        echo -e "${BLUE}🔧 Starting preview development server...${NC}"
        npm run dev:preview
        ;;
        
    "deploy:preview")
        echo -e "${BLUE}🚀 Deploying to preview environment...${NC}"
        npm run migrate:preview
        npm run deploy:preview
        print_status "Preview deployment completed"
        ;;
        
    "deploy:prod")
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
        ENV=${2:-"preview"}
        echo -e "${BLUE}🗃️  Running migrations for $ENV environment...${NC}"
        if [ "$ENV" = "production" ]; then
            wrangler d1 migrations apply AUTH_DB --remote --env production
        else
            wrangler d1 migrations apply AUTH_DB --remote --env preview
        fi
        print_status "Migrations completed for $ENV"
        ;;
        
    "logs")
        ENV=${2:-"production"}
        echo -e "${BLUE}📋 Tailing logs for $ENV environment...${NC}"
        wrangler tail --env $ENV
        ;;
        
    "status")
        echo -e "${BLUE}📊 Checking deployment status...${NC}"
        echo
        echo "Production:"
        echo "  URL: https://al-ummah-now-auth.alummahnow.workers.dev"
        echo "  Admin: https://al-ummah-now-auth.alummahnow.workers.dev/admin"
        echo
        echo "Preview:"
        echo "  URL: https://al-ummah-now-auth-preview.alummahnow.workers.dev"
        echo "  Admin: https://al-ummah-now-auth-preview.alummahnow.workers.dev/admin"
        echo
        wrangler deployments list --env production 2>/dev/null | head -5 || print_warning "Could not fetch production deployments"
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
        echo "  dev:preview    - Start development server with preview config"
        echo "  deploy:preview - Deploy to preview environment"
        echo "  deploy:prod    - Deploy to production (with confirmation)"
        echo "  migrate [env]  - Run database migrations (env: preview|production)"
        echo "  logs [env]     - Tail logs from environment (env: preview|production)"
        echo "  status         - Show deployment status and URLs"
        echo "  clean          - Clean node_modules and package-lock.json"
        echo "  help           - Show this help message"
        echo
        echo -e "${YELLOW}Examples:${NC}"
        echo "  ./dev.sh install"
        echo "  ./dev.sh test"
        echo "  ./dev.sh dev"
        echo "  ./dev.sh deploy:preview"
        echo "  ./dev.sh migrate preview"
        echo "  ./dev.sh logs production"
        ;;
esac