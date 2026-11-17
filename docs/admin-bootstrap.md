# Initial administrator bootstrap

The first administrator is restricted to **niko.oeben@gmail.com**. There is no public
admin-registration endpoint and the client cannot assign its own role. Every protected
request loads the current role from PostgreSQL.

Run the bootstrap only from a trusted deployment shell after the API database migrations
have completed:

```sh
cd services/api
ADMIN_BOOTSTRAP_EMAIL=niko.oeben@gmail.com \
ADMIN_BOOTSTRAP_PASSWORD='use-a-new-random-password-of-at-least-16-characters' \
npm run admin:bootstrap
```

Supply the password through your deployment secret manager or shell secret injection;
do not commit it, put it in the APK, or paste it into chat. The bootstrap creates the
account with role `ADMIN` and a salted scrypt password hash. Re-running it is safe
when the account is already an active ADMIN. If an account with this email already
exists with another role or is disabled, the command fails closed and requires
manual review; it never silently promotes or reactivates an existing account.

After creation, sign in through `POST /v1/auth/login`. Access tokens are short-lived,
and authorization is reloaded from the database on every request. Admin permissions
remain server-side. This bootstrap does not grant access to the Render workspace or
GitHub repository; those are separate platform permissions.
