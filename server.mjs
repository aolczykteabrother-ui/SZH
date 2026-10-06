import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const PORT = Number(process.env.PORT || 10000);
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "tea-brother.myshopify.com";
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";
const BLOG_TITLE = process.env.SHOPIFY_BLOG_TITLE || "Herbaciany blog";
const ARTICLE_AUTHOR = process.env.SHOPIFY_ARTICLE_AUTHOR || "Henryk Herbaciarz";
const ARTICLE_TEMPLATE_SUFFIX = process.env.SHOPIFY_ARTICLE_TEMPLATE_SUFFIX || "article";
const MCP_ROUTE_SECRET = process.env.MCP_ROUTE_SECRET || "";
const MCP_PATH = MCP_ROUTE_SECRET ? `/mcp/${MCP_ROUTE_SECRET}` : "/mcp";

const INTERNAL_ORIGIN = "https://sklepzherbatami.pl";
const ALLOWED_CUSTOM_KEYS = new Map([
  ["powiazana_kolekcja", "collection_reference"],
  ["powiazane_produkty", "list.product_reference"],
  ["powiazane_artykuly", "list.article_reference"],
]);
const SEO_KEYS = new Map([
  ["title_tag", "single_line_text_field"],
  ["description_tag", "single_line_text_field"],
]);

function normalizeDashes(value) {
  return typeof value === "string" ? value.replace(/[\u2013\u2014]/g, "-") : value;
}

function assertConfigured() {
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error("SHOPIFY_ADMIN_ACCESS_TOKEN is not configured on the MCP server.");
  }
}

function assertGid(value, type) {
  const re = new RegExp(`^gid://shopify/${type}/[0-9]+$`);
  if (!re.test(value)) throw new Error(`Expected Shopify ${type} GID, got: ${value}`);
}

function assertInternalLinks(html) {
  const anchorRe = /<a\b[^>]*>/gi;
  const hrefRe = /\bhref=["']([^"']+)["']/i;
  const titleRe = /\btitle=["']([^"']+)["']/i;
  for (const tag of html.match(anchorRe) || []) {
    const href = tag.match(hrefRe)?.[1];
    if (!href || !href.startsWith(INTERNAL_ORIGIN)) continue;
    if (href.includes("?")) {
      throw new Error(`Internal link must not contain a query string: ${href}`);
    }
    const title = tag.match(titleRe)?.[1]?.trim();
    if (!title) {
      throw new Error(`Internal link must contain a non-empty title attribute: ${href}`);
    }
  }
}

function normalizeArticlePayload(input) {
  const payload = {
    title: normalizeDashes(input.title),
    handle: normalizeDashes(input.handle),
    body: normalizeDashes(input.body),
    summary: normalizeDashes(input.summary),
    metaTitle: normalizeDashes(input.metaTitle),
    metaDescription: normalizeDashes(input.metaDescription),
  };
  assertInternalLinks(payload.body);
  return payload;
}

async function shopifyGraphql(query, variables = {}) {
  assertConfigured();
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data;
}

async function resolveBlog() {
  const data = await shopifyGraphql(
    `query ResolveBlog($query: String!) {
      blogs(first: 20, query: $query) {
        nodes { id title handle }
      }
    }`,
    { query: `title:"${BLOG_TITLE.replace(/"/g, "\\\"")}"` }
  );
  const exact = data.blogs.nodes.find((b) => b.title === BLOG_TITLE);
  if (!exact) throw new Error(`Blog "${BLOG_TITLE}" was not found in Shopify.`);
  return exact;
}

function numericId(gid) {
  return gid.split("/").pop();
}

async function findArticleByHandle(blogId, handle) {
  const data = await shopifyGraphql(
    `query FindArticle($query: String!) {
      articles(first: 10, query: $query) {
        nodes {
          id title handle isPublished
          blog { id title handle }
          metafields(first: 20) { nodes { namespace key type value } }
        }
      }
    }`,
    { query: `blog_id:${numericId(blogId)} AND handle:${handle}` }
  );
  return data.articles.nodes.find((a) => a.blog.id === blogId && a.handle === handle) || null;
}

async function getArticle(articleId) {
  assertGid(articleId, "Article");
  const data = await shopifyGraphql(
    `query GetArticle($id: ID!) {
      node(id: $id) {
        ... on Article {
          id title handle isPublished body summary publishedAt updatedAt templateSuffix
          author { name }
          blog { id title handle }
          metafields(first: 30) {
            nodes { namespace key type value }
          }
        }
      }
    }`,
    { id: articleId }
  );
  if (!data.node) throw new Error("Article not found.");
  return data.node;
}

function buildMetafields({ articleId, metaTitle, metaDescription, collectionId, productIds, relatedArticleIds }) {
  assertGid(articleId, "Article");
  assertGid(collectionId, "Collection");
  for (const id of productIds) assertGid(id, "Product");
  for (const id of relatedArticleIds) assertGid(id, "Article");

  return [
    {
      ownerId: articleId,
      namespace: "global",
      key: "title_tag",
      type: SEO_KEYS.get("title_tag"),
      value: normalizeDashes(metaTitle),
    },
    {
      ownerId: articleId,
      namespace: "global",
      key: "description_tag",
      type: SEO_KEYS.get("description_tag"),
      value: normalizeDashes(metaDescription),
    },
    {
      ownerId: articleId,
      namespace: "custom",
      key: "powiazana_kolekcja",
      type: ALLOWED_CUSTOM_KEYS.get("powiazana_kolekcja"),
      value: collectionId,
    },
    {
      ownerId: articleId,
      namespace: "custom",
      key: "powiazane_produkty",
      type: ALLOWED_CUSTOM_KEYS.get("powiazane_produkty"),
      value: JSON.stringify(productIds),
    },
    {
      ownerId: articleId,
      namespace: "custom",
      key: "powiazane_artykuly",
      type: ALLOWED_CUSTOM_KEYS.get("powiazane_artykuly"),
      value: JSON.stringify(relatedArticleIds),
    },
  ];
}

async function setArticleMetafields(input) {
  const article = await getArticle(input.articleId);
  const blog = await resolveBlog();
  if (article.blog.id !== blog.id) throw new Error("Article does not belong to the configured blog.");
  if (article.isPublished) throw new Error("Refusing to modify metafields on a published article.");

  const metafields = buildMetafields(input);
  const data = await shopifyGraphql(
    `mutation SetArticleMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { namespace key type value }
        userErrors { field message code }
      }
    }`,
    { metafields }
  );
  if (data.metafieldsSet.userErrors.length) {
    throw new Error(
      `Metafield write failed: ${data.metafieldsSet.userErrors.map((e) => e.message).join("; ")}`
    );
  }
  return await getArticle(input.articleId);
}

function buildServer() {
  const server = new McpServer(
    { name: "blogszh-shopify", version: "1.0.0" },
    {
      instructions:
        "This server is dedicated to sklepzherbatami.pl blog automation. It can read catalog/blog data, create hidden articles, and repair approved article metafields. It never publishes or deletes articles.",
    }
  );

  server.registerTool(
    "get_blog_context",
    {
      title: "Get blog context",
      description: "Read the configured Shopify shop, target blog and article metafield definitions before preparing a blog article.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async () => {
      const blog = await resolveBlog();
      const data = await shopifyGraphql(
        `query BlogContext {
          shop { name myshopifyDomain primaryDomain { host url } }
          metafieldDefinitions(first: 30, ownerType: ARTICLE) {
            nodes { namespace key type { name category } }
          }
        }`
      );
      const definitions = data.metafieldDefinitions.nodes.filter(
        (d) =>
          (d.namespace === "custom" && ALLOWED_CUSTOM_KEYS.has(d.key)) ||
          (d.namespace === "global" && SEO_KEYS.has(d.key))
      );
      return {
        structuredContent: { shop: data.shop, blog, definitions },
        content: [{ type: "text", text: `Target blog: ${blog.title}. Found ${definitions.length} relevant metafield definitions.` }],
      };
    }
  );

  server.registerTool(
    "list_articles",
    {
      title: "List blog articles",
      description: "List published and hidden articles from Herbaciany blog. Use this for duplicate and semantic-topic checks.",
      inputSchema: z.object({
        search: z.string().max(300).optional(),
        first: z.number().int().min(1).max(50).default(50),
        after: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async ({ search, first, after }) => {
      const blog = await resolveBlog();
      const query = search?.trim()
        ? `blog_id:${numericId(blog.id)} AND (${search.trim()})`
        : `blog_id:${numericId(blog.id)}`;
      const data = await shopifyGraphql(
        `query ListArticles($first: Int!, $after: String, $query: String!) {
          articles(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
            nodes {
              id title handle isPublished publishedAt updatedAt
              author { name }
              blog { id title handle }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first, after: after || null, query }
      );
      const articles = data.articles.nodes.filter((a) => a.blog.id === blog.id);
      return {
        structuredContent: { articles, pageInfo: data.articles.pageInfo },
        content: [{ type: "text", text: `Found ${articles.length} articles in ${blog.title}.` }],
      };
    }
  );

  server.registerTool(
    "get_article",
    {
      title: "Get article",
      description: "Read one Shopify article including body, status and metafields. Use this to verify a created hidden article.",
      inputSchema: z.object({ articleId: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async ({ articleId }) => {
      const article = await getArticle(articleId);
      return {
        structuredContent: { article },
        content: [{ type: "text", text: `Loaded article: ${article.title}.` }],
      };
    }
  );

  server.registerTool(
    "search_products",
    {
      title: "Search Shopify products",
      description: "Search current Shopify products for real examples and product references to use in an article.",
      inputSchema: z.object({
        query: z.string().max(500).default("status:active"),
        first: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async ({ query, first }) => {
      const data = await shopifyGraphql(
        `query SearchProducts($first: Int!, $query: String!) {
          products(first: $first, query: $query) {
            nodes {
              id title handle status vendor productType totalInventory
              variants(first: 5) { nodes { id sku title price inventoryQuantity } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first, query }
      );
      return {
        structuredContent: { products: data.products.nodes, pageInfo: data.products.pageInfo },
        content: [{ type: "text", text: `Found ${data.products.nodes.length} products.` }],
      };
    }
  );

  server.registerTool(
    "search_collections",
    {
      title: "Search Shopify collections",
      description: "Search current Shopify collections and return real collection GIDs and handles for internal linking and article references.",
      inputSchema: z.object({
        query: z.string().max(500).default(""),
        first: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    },
    async ({ query, first }) => {
      const data = await shopifyGraphql(
        `query SearchCollections($first: Int!, $query: String) {
          collections(first: $first, query: $query) {
            nodes {
              id title handle updatedAt
              productsCount { count }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { first, query: query || null }
      );
      return {
        structuredContent: { collections: data.collections.nodes, pageInfo: data.collections.pageInfo },
        content: [{ type: "text", text: `Found ${data.collections.nodes.length} collections.` }],
      };
    }
  );

  const referenceSchema = {
    metaTitle: z.string().min(1).max(255),
    metaDescription: z.string().min(1).max(500),
    collectionId: z.string(),
    productIds: z.array(z.string()).min(1).max(5),
    relatedArticleIds: z.array(z.string()).max(3).default([]),
  };

  server.registerTool(
    "set_hidden_article_references",
    {
      title: "Set hidden article references",
      description: "Set only the approved SEO and reference metafields on an existing hidden article. Refuses published articles and other blogs.",
      inputSchema: z.object({
        articleId: z.string(),
        ...referenceSchema,
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const article = await setArticleMetafields(input);
      return {
        structuredContent: { article },
        content: [{ type: "text", text: `Updated approved metafields on hidden article: ${article.title}.` }],
      };
    }
  );

  server.registerTool(
    "create_hidden_article",
    {
      title: "Create hidden blog article",
      description:
        "Create a new hidden article in Herbaciany blog with SEO and approved reference metafields. It always forces isPublished=false, normalizes long dashes to ASCII hyphens, rejects tracked internal URLs and internal links without title attributes, and avoids duplicates by handle.",
      inputSchema: z.object({
        title: z.string().min(3).max(255),
        handle: z.string().min(3).max(255),
        body: z.string().min(100),
        summary: z.string().min(20).max(2000),
        ...referenceSchema,
      }),
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      const normalized = normalizeArticlePayload(input);
      const blog = await resolveBlog();
      const existing = await findArticleByHandle(blog.id, normalized.handle);

      if (existing) {
        if (existing.isPublished) {
          throw new Error("An article with this handle already exists and is published. Refusing to modify or duplicate it.");
        }
        const repaired = await setArticleMetafields({
          articleId: existing.id,
          metaTitle: normalized.metaTitle,
          metaDescription: normalized.metaDescription,
          collectionId: input.collectionId,
          productIds: input.productIds,
          relatedArticleIds: input.relatedArticleIds,
        });
        return {
          structuredContent: { article: repaired, alreadyExisted: true, created: false },
          content: [{ type: "text", text: `Hidden article already existed. Reused ${existing.id} and verified its approved metafields.` }],
        };
      }

      const data = await shopifyGraphql(
        `mutation CreateHiddenArticle($article: ArticleCreateInput!) {
          articleCreate(article: $article) {
            article { id title handle isPublished }
            userErrors { field message }
          }
        }`,
        {
          article: {
            blogId: blog.id,
            title: normalized.title,
            handle: normalized.handle,
            body: normalized.body,
            summary: normalized.summary,
            author: { name: ARTICLE_AUTHOR },
            isPublished: false,
            templateSuffix: ARTICLE_TEMPLATE_SUFFIX || null,
          },
        }
      );

      const errors = data.articleCreate.userErrors || [];
      if (errors.length || !data.articleCreate.article) {
        throw new Error(`Article create failed: ${errors.map((e) => e.message).join("; ") || "unknown error"}`);
      }

      const created = data.articleCreate.article;
      if (created.isPublished) {
        throw new Error(`Safety check failed: Shopify returned a published article ${created.id}.`);
      }

      try {
        const verified = await setArticleMetafields({
          articleId: created.id,
          metaTitle: normalized.metaTitle,
          metaDescription: normalized.metaDescription,
          collectionId: input.collectionId,
          productIds: input.productIds,
          relatedArticleIds: input.relatedArticleIds,
        });
        return {
          structuredContent: { article: verified, alreadyExisted: false, created: true, metafieldsVerified: true },
          content: [{ type: "text", text: `Created and verified hidden article: ${verified.title}.` }],
        };
      } catch (error) {
        return {
          structuredContent: {
            article: created,
            alreadyExisted: false,
            created: true,
            metafieldsVerified: false,
            repairNeeded: true,
            repairError: error instanceof Error ? error.message : String(error),
          },
          content: [{
            type: "text",
            text: `Article was created as hidden (${created.id}), but metafield verification failed. Do not create another article; repair this ID with set_hidden_article_references.`,
          }],
        };
      }
    }
  );

  return server;
}

const handler = createMcpHandler(buildServer);
const nodeHandler = toNodeHandler(handler);

const app = createMcpExpressApp({ host: "0.0.0.0" });

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "blogszh-shopify-mcp",
    shop: SHOPIFY_STORE_DOMAIN,
    blog: BLOG_TITLE,
    apiVersion: SHOPIFY_API_VERSION,
    tokenConfigured: Boolean(SHOPIFY_ADMIN_ACCESS_TOKEN),
    mcpPathConfigured: Boolean(MCP_ROUTE_SECRET),
  });
});

app.all(MCP_PATH, (req, res) => void nodeHandler(req, res, req.body));

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`blogSZH Shopify MCP listening on port ${PORT}`);
});
