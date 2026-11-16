# Environment Variables Analysis

## Grouping and Explanations

### Database Variables
These variables are used to connect to the PostgreSQL database.
- **`DB_USER`**
  - **Used in**: `backend/utils/cronUtils.js`, `backend/server.js`
  - **Purpose**: Specifies the username used to authenticate with the database.
- **`DB_HOST`**
  - **Used in**: `backend/utils/cronUtils.js`, `backend/server.js`
  - **Purpose**: Defines the hostname or IP address of the database server.
- **`DB_NAME`**
  - **Used in**: `backend/utils/cronUtils.js`, `backend/server.js`
  - **Purpose**: Specifies the name of the database to connect to.
- **`DB_PASSWORD`**
  - **Used in**: `backend/utils/cronUtils.js`, `backend/server.js`
  - **Purpose**: The password for the specified database user.
- **`DB_PORT`**
  - **Used in**: `backend/utils/cronUtils.js`, `backend/server.js`
  - **Purpose**: The port on which the database server is listening (usually 5432 for PostgreSQL).

### API Keys
These variables store keys needed to communicate with external APIs.
- **`FOXY_API_KEY`**
  - **Used in**: `backend/utils/cronUtils.js`, `backend/server.js`
  - **Purpose**: API key for integrating with the Foxy API (e.g., Foxy Game Store).
- **`PGS_KEY`**
  - **Used in**: `backend/utils/validators/cek-id-game.js`
  - **Purpose**: Key used for game ID validation/checking.
- **`PGS_API_KEY`**
  - **Used in**: `backend/utils/validators/cek-id-game.js`
  - **Purpose**: Additional API key for the game ID validation/checking service.
- **`BREVO_API_KEY`**
  - **Used in**: `backend/utils/mailer.js`
  - **Purpose**: API key for the Brevo service, used for sending emails.

### Auth Variables
Variables used for handling authentication and security.
- **`JWT_SECRET`**
  - **Used in**: `backend/server.js`, `backend/tests/auth.test.js`
  - **Purpose**: The secret key used to sign and verify JSON Web Tokens (JWT) for user authentication.

### Config Variables
General configuration settings for the backend application.
- **`PORT`**
  - **Used in**: `backend/server.js`, `backend/tests/auth.test.js`
  - **Purpose**: The port on which the Express server listens for incoming HTTP requests.

## Critical Variables for the App to Run
The following variables are essential for the basic operation and startup of the application. Without them, the application may fail to start, connect to the database, or authenticate users properly:

- `DB_USER`
- `DB_HOST`
- `DB_NAME`
- `DB_PASSWORD`
- `DB_PORT`
- `JWT_SECRET`
- `PORT` (though it often falls back to a default like 3000)
