export const ANTIGRAVITY_BASE_URLS = Object.freeze([
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
]);

const ANTIGRAVITY_MODELS_PATH = "/v1internal:models";
const ANTIGRAVITY_FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
const ANTIGRAVITY_LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist";
const ANTIGRAVITY_ONBOARD_USER_PATH = "/v1internal:onboardUser";

function buildAntigravityUrls(path: string): string[] {
  return ANTIGRAVITY_BASE_URLS.map((baseUrl) => `${baseUrl}${path}`);
}

export function getAntigravityModelsDiscoveryUrls(): string[] {
  return buildAntigravityUrls(ANTIGRAVITY_MODELS_PATH);
}

export function getAntigravityFetchAvailableModelsUrls(): string[] {
  return buildAntigravityUrls(ANTIGRAVITY_FETCH_AVAILABLE_MODELS_PATH);
}

export function getAntigravityOnboardUrls(): string[] {
  return buildAntigravityUrls(ANTIGRAVITY_ONBOARD_USER_PATH);
}

export function getAntigravityLoadCodeAssistUrls(): string[] {
  return buildAntigravityUrls(ANTIGRAVITY_LOAD_CODE_ASSIST_PATH);
}
