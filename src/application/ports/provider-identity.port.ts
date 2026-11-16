export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  authenticate(authorizationHeader: string | undefined): Promise<ProviderIdentity>;
}
