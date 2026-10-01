import {
  UserDataFunctions,
  AudienceType,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';

import type { BlankAppSchema } from '../../data/schema.js';

const udf = new UserDataFunctions();

/**
 * Hand the browser a OneLake (https://storage.azure.com) bearer token so DuckDB-WASM can read the
 * Lakehouse Files directly — replaces the separate MSAL SPA login, and works inside the Fabric
 * portal iframe because the caller authenticates through Rayfin's Fabric SSO.
 *
 * The token is issued to the app identity (owner of the Fabric app item), so every signed-in user
 * of this app reads/writes OneLake with the owner's permissions. Deliberate: per-user identity is
 * not a requirement here, only getting a token.
 */
udf.func(
  'getStorageToken',
  async (
    ctx: RayfinContext<BlankAppSchema, AudienceType.Storage>,
  ): Promise<{ token: string }> => {
    return { token: ctx.Tokens.Storage };
  },
  [],
);
