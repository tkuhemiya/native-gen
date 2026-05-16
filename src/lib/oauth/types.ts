export type GoogleAccountStored = {
  refreshToken: string;
  scope?: string;
  channelId?: string;
  channelTitle?: string;
  connectedAt: string;
};

export type MetaPageStored = {
  id: string;
  name: string;
  pageAccessToken: string;
  instagramUserId?: string;
  instagramUsername?: string;
};

export type MetaAccountStored = {
  userId: string;
  userName?: string;
  userAccessToken: string;
  userTokenExpiresAt?: string;
  pages: MetaPageStored[];
  connectedAt: string;
};

export type SocialAccountsBlob = {
  google?: GoogleAccountStored;
  meta?: MetaAccountStored;
};

export type OAuthProvider = "google" | "meta";
