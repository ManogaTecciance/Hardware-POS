import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Machine-readable authentication outcomes (Slice 7.2).
 *
 * Codes exist so the browser can react without parsing prose — the login form has
 * to know when to reveal the Workspace field, and matching on an English sentence
 * would break the first time the wording changed.
 */
export enum AuthErrorCode {
  /** The email exists in more than one workspace; the caller must say which. */
  WORKSPACE_REQUIRED = 'AUTH_WORKSPACE_REQUIRED',
}

/**
 * The email matched active accounts in several workspaces.
 *
 * ## What this deliberately does not say
 *
 * No tenant names, no slugs, no count, and no confirmation that any particular
 * workspace holds the address. The client learns exactly one thing: *supply a
 * workspace*. A response that listed the candidates would be a directory of which
 * companies a person works for, readable by anyone who can guess their email.
 *
 * ## The residual disclosure, stated plainly
 *
 * This response does reveal that the submitted address exists in **more than one**
 * workspace, which a generic 401 would not. That is inherent to the approved
 * contract — the alternative is to fail every ambiguous login with no way for a
 * legitimate user to proceed — and it is a much narrower leak than naming the
 * tenants. Single-tenant addresses, which are the overwhelming majority, disclose
 * nothing: they return the same generic 401 as an unknown address.
 *
 * 409 rather than 400: the request is well-formed, and the conflict is with server
 * state (several accounts) rather than with the payload.
 */
export class WorkspaceRequiredError extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        code: AuthErrorCode.WORKSPACE_REQUIRED,
        message: 'Please enter your workspace to continue.',
        error: 'Conflict',
      },
      HttpStatus.CONFLICT,
    );
  }
}
