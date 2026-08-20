import { createProviderConnection, getProviderConnections } from "../src/lib/db/providers.ts";
import { getDbInstance } from "../src/lib/db/core.ts";

const fullCookie = `postman.sid=626c25455a3e6bd69df6f0045e7f8c9e748fc6ef36e3399fc42354ac8083e600926fde806a2dfb481413a2909014d7131fcbcbadec26885ffba8728f2f8f56854cf2e69720896fc4395d7f84af58ca3f91b0120107e7b995f801c1f0b5e65a597e6066ea8c4e03e40d8c604fa1e665322def3d2034c583b2effbe2c2326658b5f5a733fe3726f7aff2c347d57d2b92b5fdfc808842d836ad9501f39584768840e477e1b492c871aab18b5ecdae3207ad410a1a40e20d1c03cd29a231db96a47b0b8ba902573bbfec13de412b7e4ef78bcef9910d5134d06fba1cf2b7fdf6c901a85fd6e43d01b5af925d7d220af985651d4420bef02e8eaf0aa2ec48cba8fd4b0848a16348c0e1d159f592d0a27a0213434c1d80ef117259ad1a89af249ab7e3b4486347637e9922341995a6818a061ff076a8db65adc5baa23bce0d7e517dfad164589d027ee41aacbbdb734326c04a06c752e2bd31271ed8feca257b9e0effce8d1b555d96afd9868f1a4d728a7f9c630d41bc9ac5744839458bd826c1850929e0c383058435f56332cfbf29ae60beae66a4bc0e3631e17cd2870d07f6f2fd291ee769db85930f0650b6ffa01efb5662eab497f68fe88849388cab9eefde4127441df23476d0dd156067e84a1479cce0a69b54d008c262260820092bd0a0edc76cf2; _cfuvid=avetgJtsGLZ.UOjfL4mGerURQi.mTysDckeSE0tJ1m4-1787223750.1727436-1.0.1.1-LZJpINzaCvfGH5H9H2wbZl1EGzZoltMX3avPSgGTNb0; __cf_bm=xHAa686S.kv9rqQ1eDcDvrF1z6Ns0gxbtwYPTHVCX9o-1787223739.54965-1.0.1.1-X4_6OZ5yLD5AXLRXDt.tZ_uJO5IR6WUltMGAK8pSPQiL7Zqhlox97N.DsQ8.H6gq3zjLaLL9ixmdgpE_6gC1UJSxBGZDKpziePvWxztANYVsz3AaD4Hyiwi2USZB4S6x; dashboard_beta=yes`;

async function updateCookies() {
  const db: any = getDbInstance();
  db.prepare("DELETE FROM provider_connections WHERE provider = 'postman-agent'").run();

  const res = await createProviderConnection({
    provider: "postman-agent",
    name: "Postman Agent (Claude Opus 4.8)",
    authType: "apikey",
    apiKey: fullCookie,
    email: "epsiloncryptoai@gmail.com",
    isActive: true,
    priority: 0,
    providerSpecificData: {
      teamDomain: "epsiloncryptoai-7880991",
      workspaceId: "280d1867-5a3e-41c7-8465-9e4b0edf866f",
    },
  });

  console.log("Updated SQLite with fresh session cookie:", res?.id);
}

updateCookies().catch(console.error);
