# Claude Code Development Process

## CRITICAL: Follow This Process for Every Development Task

## For NEW Features/Implementation

When working on any development task, especially those involving frameworks, libraries, or APIs:

### 1. SEARCH FIRST
- **Before writing any code**, search for official documentation
- Use WebSearch to find the latest documentation (include current year in search)
- Look for official docs, GitHub repos, and authoritative sources
- Don't rely on assumptions or prior knowledge

### 2. READ THOROUGHLY
- Use WebFetch to read the official documentation
- Read the ENTIRE relevant section, don't skim
- Pay special attention to:
  - Getting Started guides
  - Configuration examples
  - API references
  - Best practices
  - Common pitfalls

### 3. SUGGEST SOLUTION
- Present what you found in the documentation
- Suggest a solution based on the official docs
- Quote relevant parts of the documentation
- Explain why this approach is correct

### 4. GET APPROVAL
- Wait for user confirmation before implementing
- Discuss any uncertainties
- Ask clarifying questions if needed

### 5. THEN CODE
- Only implement after approval
- Follow the documentation exactly
- Don't add your own "improvements" unless discussed
- Test the implementation

## For FIXING Issues/Bugs

When debugging or fixing existing code:

### 1. CHECK LOGS FIRST
- Read application logs, error messages, stack traces
- Check database logs if applicable
- Review browser console, network requests
- Gather ALL error context before proceeding

### 2. ANALYZE THE ISSUE
- Identify the root cause from the logs
- Trace the error back to its source
- Check what values are actually present vs expected
- Don't assume - verify with actual data

### 3. SEARCH DOCUMENTATION
- Once you understand the issue, search for relevant docs
- Look for error handling patterns
- Check API documentation for the failing method
- Review examples of correct usage

### 4. SUGGEST FIX
- Present your analysis of the root cause
- Show evidence from logs
- Suggest a fix based on documentation
- Explain why this will solve the problem

### 5. GET APPROVAL
- Wait for confirmation before fixing
- Discuss if the analysis is correct
- Clarify any uncertainties

### 6. IMPLEMENT FIX
- Apply the fix
- Verify it solves the root cause
- Test to ensure no regressions

## Example: React Router + Cloudflare Workers

**WRONG Approach (what NOT to do):**
- Assume `@react-router/cloudflare` is the right import
- Guess at the worker configuration
- Try multiple approaches without checking docs
- Waste time debugging self-created problems

**CORRECT Approach:**
1. Search: "React Router Cloudflare adapter documentation 2025"
2. Read: https://reactrouter.com/api/other-api/adapter#react-routercloudflare
3. Suggest: "According to the official docs, we should use `createRequestHandler` from `react-router` (not `@react-router/cloudflare`) and pass only `{ env, ctx }`"
4. Get approval
5. Implement exactly as documented

## Key Reminders

- **Documentation > Assumptions**: Always check official docs first
- **Read, don't skim**: Take time to understand before coding
- **Follow exactly**: Don't improvise on official patterns
- **Ask when unsure**: Better to ask than to implement incorrectly

## When in Doubt

If you're not 100% certain about how something works:
1. Stop
2. Search for documentation
3. Read it thoroughly
4. Then proceed

**Never guess when you can search and read.**
