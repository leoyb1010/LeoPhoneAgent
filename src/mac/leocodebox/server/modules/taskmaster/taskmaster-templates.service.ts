export type PrdTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  content: string;
};

export function getAvailableTemplates(): PrdTemplate[] {
  return [
      {
          id: 'web-app',
          name: 'Web Application',
          description: 'Template for web application projects with frontend and backend components',
          category: 'web',
          content: `# Product Requirements Document - Web Application

## Overview
**Product Name:** [Your App Name]
**Version:** 1.0
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Brief description of what this web application will do and why it's needed.

## Product Goals
- Goal 1: [Specific measurable goal]
- Goal 2: [Specific measurable goal]
- Goal 3: [Specific measurable goal]

## User Stories
### Core Features
1. **User Registration & Authentication**
   - As a user, I want to create an account so I can access personalized features
   - As a user, I want to log in securely so my data is protected
   - As a user, I want to reset my password if I forget it

2. **Main Application Features**
   - As a user, I want to [core feature 1] so I can [benefit]
   - As a user, I want to [core feature 2] so I can [benefit]
   - As a user, I want to [core feature 3] so I can [benefit]

3. **User Interface**
   - As a user, I want a responsive design so I can use the app on any device
   - As a user, I want intuitive navigation so I can easily find features

## Technical Requirements
### Frontend
- Framework: React/Vue/Angular or vanilla JavaScript
- Styling: CSS framework (Tailwind, Bootstrap, etc.)
- State Management: Redux/Vuex/Context API
- Build Tools: Webpack/Vite
- Testing: Jest/Vitest for unit tests

### Backend
- Runtime: Node.js/Python/Java
- Database: PostgreSQL/MySQL/MongoDB
- API: RESTful API or GraphQL
- Authentication: JWT tokens
- Testing: Integration and unit tests

### Infrastructure
- Hosting: Cloud provider (AWS, Azure, GCP)
- CI/CD: GitHub Actions/GitLab CI
- Monitoring: Application monitoring tools
- Security: HTTPS, input validation, rate limiting

## Success Metrics
- User engagement metrics
- Performance benchmarks (load time < 2s)
- Error rates < 1%
- User satisfaction scores

## Timeline
- Phase 1: Core functionality (4-6 weeks)
- Phase 2: Advanced features (2-4 weeks)
- Phase 3: Polish and launch (2 weeks)

## Constraints & Assumptions
- Budget constraints
- Technical limitations
- Team size and expertise
- Timeline constraints`
      },
      {
          id: 'api',
          name: 'REST API',
          description: 'Template for REST API development projects',
          category: 'backend',
          content: `# Product Requirements Document - REST API

## Overview
**API Name:** [Your API Name]
**Version:** v1.0
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Description of the API's purpose, target users, and primary use cases.

## API Goals
- Goal 1: Provide secure data access
- Goal 2: Ensure scalable architecture
- Goal 3: Maintain high availability (99.9% uptime)

## Functional Requirements
### Core Endpoints
1. **Authentication Endpoints**
   - POST /api/auth/login - User authentication
   - POST /api/auth/logout - User logout
   - POST /api/auth/refresh - Token refresh
   - POST /api/auth/register - User registration

2. **Data Management Endpoints**
   - GET /api/resources - List resources with pagination
   - GET /api/resources/{id} - Get specific resource
   - POST /api/resources - Create new resource
   - PUT /api/resources/{id} - Update existing resource
   - DELETE /api/resources/{id} - Delete resource

3. **Administrative Endpoints**
   - GET /api/admin/users - Manage users (admin only)
   - GET /api/admin/analytics - System analytics
   - POST /api/admin/backup - Trigger system backup

## Technical Requirements
### API Design
- RESTful architecture following OpenAPI 3.0 specification
- JSON request/response format
- Consistent error response format
- API versioning strategy

### Authentication & Security
- JWT token-based authentication
- Role-based access control (RBAC)
- Rate limiting (100 requests/minute per user)
- Input validation and sanitization
- HTTPS enforcement

### Database
- Database type: [PostgreSQL/MongoDB/MySQL]
- Connection pooling
- Database migrations
- Backup and recovery procedures

### Performance Requirements
- Response time: < 200ms for 95% of requests
- Throughput: 1000+ requests/second
- Concurrent users: 10,000+
- Database query optimization

### Documentation
- Auto-generated API documentation (Swagger/OpenAPI)
- Code examples for common use cases
- SDK development for major languages
- Postman collection for testing

## Error Handling
- Standardized error codes and messages
- Proper HTTP status codes
- Detailed error logging
- Graceful degradation strategies

## Testing Strategy
- Unit tests (80%+ coverage)
- Integration tests for all endpoints
- Load testing and performance testing
- Security testing (OWASP compliance)

## Monitoring & Logging
- Application performance monitoring
- Error tracking and alerting
- Access logs and audit trails
- Health check endpoints

## Deployment
- Containerized deployment (Docker)
- CI/CD pipeline setup
- Environment management (dev, staging, prod)
- Blue-green deployment strategy

## Success Metrics
- API uptime > 99.9%
- Average response time < 200ms
- Zero critical security vulnerabilities
- Developer adoption metrics`
      },
      {
          id: 'mobile-app',
          name: 'Mobile Application',
          description: 'Template for mobile app development projects (iOS/Android)',
          category: 'mobile',
          content: `# Product Requirements Document - Mobile Application

## Overview
**App Name:** [Your App Name]
**Platform:** iOS / Android / Cross-platform
**Version:** 1.0
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Brief description of the mobile app's purpose, target audience, and key value proposition.

## Product Goals
- Goal 1: [Specific user engagement goal]
- Goal 2: [Specific functionality goal]
- Goal 3: [Specific performance goal]

## User Stories
### Core Features
1. **Onboarding & Authentication**
   - As a new user, I want a simple onboarding process
   - As a user, I want to sign up with email or social media
   - As a user, I want biometric authentication for security

2. **Main App Features**
   - As a user, I want [core feature 1] accessible from home screen
   - As a user, I want [core feature 2] to work offline
   - As a user, I want to sync data across devices

3. **User Experience**
   - As a user, I want intuitive navigation patterns
   - As a user, I want fast loading times
   - As a user, I want accessibility features

## Technical Requirements
### Mobile Development
- **Cross-platform:** React Native / Flutter / Xamarin
- **Native:** Swift (iOS) / Kotlin (Android)
- **State Management:** Redux / MobX / Provider
- **Navigation:** React Navigation / Flutter Navigation

### Backend Integration
- REST API or GraphQL integration
- Real-time features (WebSockets/Push notifications)
- Offline data synchronization
- Background processing

### Device Features
- Camera and photo library access
- GPS location services
- Push notifications
- Biometric authentication
- Device storage

### Performance Requirements
- App launch time < 3 seconds
- Screen transition animations < 300ms
- Memory usage optimization
- Battery usage optimization

## Platform-Specific Considerations
### iOS Requirements
- iOS 13.0+ minimum version
- App Store guidelines compliance
- iOS design guidelines (Human Interface Guidelines)
- TestFlight beta testing

### Android Requirements
- Android 8.0+ (API level 26) minimum
- Google Play Store guidelines
- Material Design guidelines
- Google Play Console testing

## User Interface Design
- Responsive design for different screen sizes
- Dark mode support
- Accessibility compliance (WCAG 2.1)
- Consistent design system

## Security & Privacy
- Secure data storage (Keychain/Keystore)
- API communication encryption
- Privacy policy compliance (GDPR/CCPA)
- App security best practices

## Testing Strategy
- Unit testing (80%+ coverage)
- UI/E2E testing (Detox/Appium)
- Device testing on multiple screen sizes
- Performance testing
- Security testing

## App Store Deployment
- App store optimization (ASO)
- App icons and screenshots
- Store listing content
- Release management strategy

## Analytics & Monitoring
- User analytics (Firebase/Analytics)
- Crash reporting (Crashlytics/Sentry)
- Performance monitoring
- User feedback collection

## Success Metrics
- App store ratings > 4.0
- User retention rates
- Daily/Monthly active users
- App performance metrics
- Conversion rates`
      },
      {
          id: 'data-analysis',
          name: 'Data Analysis Project',
          description: 'Template for data analysis and visualization projects',
          category: 'data',
          content: `# Product Requirements Document - Data Analysis Project

## Overview
**Project Name:** [Your Analysis Project]
**Analysis Type:** [Descriptive/Predictive/Prescriptive]
**Date:** ${new Date().toISOString().split('T')[0]}
**Author:** [Your Name]

## Executive Summary
Description of the business problem, data sources, and expected insights.

## Project Goals
- Goal 1: [Specific business question to answer]
- Goal 2: [Specific prediction to make]
- Goal 3: [Specific recommendation to provide]

## Business Requirements
### Key Questions
1. What patterns exist in the current data?
2. What factors influence [target variable]?
3. What predictions can be made for [future outcome]?
4. What recommendations can improve [business metric]?

### Success Criteria
- Actionable insights for stakeholders
- Statistical significance in findings
- Reproducible analysis pipeline
- Clear visualization and reporting

## Data Requirements
### Data Sources
1. **Primary Data**
   - Source: [Database/API/Files]
   - Format: [CSV/JSON/SQL]
   - Size: [Volume estimate]
   - Update frequency: [Real-time/Daily/Monthly]

2. **External Data**
   - Third-party APIs
   - Public datasets
   - Market research data

### Data Quality Requirements
- Data completeness (< 5% missing values)
- Data accuracy validation
- Data consistency checks
- Historical data availability

## Technical Requirements
### Data Pipeline
- Data extraction and ingestion
- Data cleaning and preprocessing
- Data transformation and feature engineering
- Data validation and quality checks

### Analysis Tools
- **Programming:** Python/R/SQL
- **Libraries:** pandas, numpy, scikit-learn, matplotlib
- **Visualization:** Tableau, PowerBI, or custom dashboards
- **Version Control:** Git for code and DVC for data

### Computing Resources
- Local development environment
- Cloud computing (AWS/GCP/Azure) if needed
- Database access and permissions
- Storage requirements

## Analysis Methodology
### Data Exploration
1. Descriptive statistics and data profiling
2. Data visualization and pattern identification
3. Correlation analysis
4. Outlier detection and handling

### Statistical Analysis
1. Hypothesis formulation
2. Statistical testing
3. Confidence intervals
4. Effect size calculations

### Machine Learning (if applicable)
1. Feature selection and engineering
2. Model selection and training
3. Cross-validation and evaluation
4. Model interpretation and explainability

## Deliverables
### Reports
- Executive summary for stakeholders
- Technical analysis report
- Data quality report
- Methodology documentation

### Visualizations
- Interactive dashboards
- Static charts and graphs
- Data story presentations
- Key findings infographics

### Code & Documentation
- Reproducible analysis scripts
- Data pipeline code
- Documentation and comments
- Testing and validation code

## Timeline
- Phase 1: Data collection and exploration (2 weeks)
- Phase 2: Analysis and modeling (3 weeks)
- Phase 3: Reporting and visualization (1 week)
- Phase 4: Stakeholder presentation (1 week)

## Risks & Assumptions
- Data availability and quality risks
- Technical complexity assumptions
- Resource and timeline constraints
- Stakeholder engagement assumptions

## Success Metrics
- Stakeholder satisfaction with insights
- Accuracy of predictions (if applicable)
- Business impact of recommendations
- Reproducibility of results`
      }
  ];
}
