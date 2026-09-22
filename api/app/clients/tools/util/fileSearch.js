const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { tool } = require('@librechat/agents/langchain/tools');
const {
  logAxiosError,
  selectFileCitationSources,
  generateShortLivedToken,
  queryKnowledgeFiles,
  rankKnowledgeCandidates,
  resolveAuthorizedKnowledgeFiles,
} = require('@librechat/api');
const { Tools, EModelEndpoint, EToolResources } = require('librechat-data-provider');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { getFiles } = require('~/models');

const fileSearchJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents.",
    },
  },
  required: ['query'],
};

/**
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Agent['tool_resources']} options.tool_resources
 * @param {string} [options.agentId] - The agent ID for file access control
 * @param {string} [options.agentResourceType] - Permission resource type for the authorized agent route
 * @param {string[]} [options.knowledgeBaseIds]
 * @param {boolean} [options.knowledgeBaseOnly=false]
 * @param {import('@librechat/api').KnowledgeRetrievalDependencies} [options.knowledgeRetrieval]
 * @returns {Promise<{
 *   files: Array<{ file_id: string; filename: string; fromAgent: boolean }>,
 *   toolContext: string
 * }>}
 */
const primeFiles = async (options) => {
  const {
    tool_resources,
    req,
    agentId,
    agentResourceType,
    knowledgeRetrieval,
    knowledgeBaseIds: explicitKnowledgeBaseIds,
    knowledgeBaseOnly = false,
  } = options;
  // `knowledge_base_only` separates an ephemeral chat's KB selection from the
  // legacy direct-file toggle. A persisted Agent's configured files are part
  // of that Agent's retrieval contract and must remain available when a chat
  // temporarily adds a KB.
  const excludeDirectFiles = knowledgeBaseOnly && !agentId;
  const file_ids = excludeDirectFiles
    ? []
    : (tool_resources?.[EToolResources.file_search]?.file_ids ?? []);
  const knowledgeBaseIds = Array.from(
    new Set([
      ...(explicitKnowledgeBaseIds ?? []),
      ...(tool_resources?.[EToolResources.file_search]?.knowledge_base_ids ?? []),
    ]),
  );
  const agentResourceIds = new Set(file_ids);
  const resourceFiles = excludeDirectFiles
    ? []
    : (tool_resources?.[EToolResources.file_search]?.files ?? []);

  // Get all files first
  const allFiles =
    file_ids.length > 0
      ? ((await getFiles({ file_id: { $in: file_ids } }, null, { text: 0 })) ?? [])
      : [];

  // Filter by access if user and agent are provided
  let dbFiles;
  if (req?.user?.id && agentId) {
    dbFiles = await filterFilesByAgentAccess({
      files: allFiles,
      userId: req.user.id,
      role: req.user.role,
      agentId,
      resourceType: agentResourceType,
    });
  } else {
    dbFiles = allFiles;
  }

  dbFiles = dbFiles.concat(resourceFiles);

  let knowledgeFiles = [];
  if (knowledgeBaseIds.length > 0) {
    if (!knowledgeRetrieval) {
      throw new Error('Knowledge-base retrieval dependencies are not configured');
    }
    knowledgeFiles = await resolveAuthorizedKnowledgeFiles(
      {
        knowledgeBaseIds,
        userId: req?.user?.id,
        role: req?.user?.role,
      },
      knowledgeRetrieval,
    );
  }

  const files = [];
  for (let i = 0; i < dbFiles.length; i++) {
    const file = dbFiles[i];
    if (!file) {
      continue;
    }
    files.push({
      file_id: file.file_id,
      filename: file.filename,
      fromAgent: agentResourceIds.has(file.file_id),
    });
  }

  const seenKnowledgeFiles = new Set();
  for (const file of knowledgeFiles) {
    const key = `${file.knowledge_base_id}:${file.file_id}`;
    if (seenKnowledgeFiles.has(key)) {
      continue;
    }
    files.push(file);
    seenKnowledgeFiles.add(key);
  }

  let toolContext;
  if (files.length > 0) {
    const visibleFiles = files.slice(0, 20);
    toolContext = `- Note: Use the ${Tools.file_search} tool to find relevant information within:`;
    toolContext += visibleFiles
      .map((file) => {
        if (file.fromKnowledgeBase === true) {
          const provenance = [file.knowledge_base_name, file.knowledge_source_name]
            .filter(Boolean)
            .join(' / ');
          return `\n\t- ${file.filename} (from knowledge base${provenance ? `: ${provenance}` : ''})`;
        }
        return `\n\t- ${file.filename}${file.fromAgent ? '' : ' (just attached by user)'}`;
      })
      .join('');
    if (files.length > visibleFiles.length) {
      toolContext += `\n\t- …and ${files.length - visibleFiles.length} more searchable documents`;
    }
  } else if (knowledgeBaseIds.length > 0) {
    toolContext = `- Note: Use the ${Tools.file_search} tool to search the selected knowledge bases.`;
  } else {
    toolContext = `- Note: Semantic search is available through the ${Tools.file_search} tool but no files are currently loaded. Request the user to upload documents to search through.`;
  }

  return { files, toolContext, knowledgeBaseIds };
};

/**
 *
 * @param {Object} options
 * @param {AppConfig} [options.appConfig]
 * @param {string} options.userId
 * @param {Array<{ file_id: string; filename: string; fromAgent?: boolean }>} options.files
 * @param {string} [options.entity_id]
 * @param {boolean} [options.fileCitations=false] - Whether to include citation instructions
 * @returns
 */
const createFileSearchTool = async ({
  userId,
  files,
  entity_id,
  fileCitations = false,
  appConfig,
}) => {
  return tool(
    async ({ query }) => {
      if (files.length === 0) {
        return ['No files to search. Instruct the user to add files for the search.', undefined];
      }
      const jwtToken = generateShortLivedToken(userId);
      if (!jwtToken) {
        return ['There was an error authenticating the file search request.', undefined];
      }

      /**
       * @param {import('librechat-data-provider').TFile & { fromAgent?: boolean }} file
       * @returns {{ file_id: string, query: string, k: number, entity_id?: string }}
       */
      const createQueryBody = (file) => {
        const body = {
          file_id: file.file_id,
          query,
          k: 5,
        };
        // User-attached files are embedded under the user id (no entity);
        // only agent knowledge-base files carry the agent's entity_id.
        // Sending entity_id for user attachments makes the RAG API's entity
        // filter return no results for them. When files are provided by
        // primeFiles, fromAgent is always set; for callers that pass files
        // directly without the flag, the safe default is unscoped (no
        // entity_id).
        if (!entity_id || file.fromAgent !== true) {
          return body;
        }
        body.entity_id = entity_id;
        logger.debug(`[${Tools.file_search}] RAG API /query body`, body);
        return body;
      };

      const knowledgeFiles = files.filter((file) => file.fromKnowledgeBase === true);
      const directFiles = files.filter((file) => file.fromKnowledgeBase !== true);
      const queryPromises = directFiles.map((file) =>
        axios
          .post(`${process.env.RAG_API_URL}/query`, createQueryBody(file), {
            headers: {
              Authorization: `Bearer ${jwtToken}`,
              'Content-Type': 'application/json',
            },
          })
          .then((result) => ({ data: result.data, file_id: file.file_id }))
          .catch((error) => {
            logAxiosError({
              message: 'Error encountered in `file_search` while querying file',
              error,
            });
            return null;
          }),
      );

      if (knowledgeFiles.length > 0) {
        queryPromises.push(
          queryKnowledgeFiles(
            {
              ragApiUrl: process.env.RAG_API_URL,
              jwtToken,
              query,
              files: knowledgeFiles,
              k: 10,
            },
            axios,
          )
            .then((data) => ({ data }))
            .catch((error) => {
              logAxiosError({
                message: 'Error encountered in `file_search` while querying knowledge bases',
                error,
              });
              return null;
            }),
        );
      }

      const results = await Promise.all(queryPromises);
      const validResults = results.filter((result) => result !== null);

      if (validResults.length === 0) {
        return ['No results found or errors occurred while searching the files.', undefined];
      }

      const filesById = new Map(files.map((file) => [file.file_id, file]));
      const knowledgeFilesByKey = new Map(
        knowledgeFiles.map((file) => [`${file.knowledge_base_id}:${file.file_id}`, file]),
      );
      const candidates = validResults
        .flatMap((result) =>
          result.data.map(([docInfo, distance]) => {
            const fileId = result.file_id ?? docInfo.metadata?.file_id;
            const knowledgeBaseId = docInfo.metadata?.knowledge_base_id;
            const matchedFile = filesById.get(fileId);
            const knowledgeFile =
              knowledgeFilesByKey.get(`${knowledgeBaseId}:${fileId}`) ??
              (matchedFile?.fromKnowledgeBase === true ? matchedFile : undefined);
            const file = knowledgeFile ?? matchedFile;
            const source = docInfo.metadata?.source;
            const sourceName = typeof source === 'string' ? source.split('/').pop() : undefined;
            return {
              filename: file?.filename ?? sourceName ?? fileId,
              content: docInfo.page_content,
              distance,
              file_id: fileId,
              canonicalUrl:
                typeof docInfo.metadata?.canonical_url === 'string'
                  ? docInfo.metadata.canonical_url
                  : knowledgeFile?.canonical_url,
              knowledgeBaseName: knowledgeFile?.knowledge_base_name,
              knowledgeSourceName: knowledgeFile?.knowledge_source_name,
              sourceType: knowledgeFile?.source_type,
              sourceKey:
                knowledgeFile?.knowledge_source_name ?? knowledgeFile?.knowledge_base_id ?? fileId,
              page:
                Number.isInteger(docInfo.metadata?.page) && docInfo.metadata.page >= 0
                  ? docInfo.metadata.page + 1
                  : null,
            };
          }),
        )
        .filter((result) => result.file_id && result.filename);
      const formattedResults = rankKnowledgeCandidates({
        query,
        candidates,
        limit: 10,
        maxPerSource: 4,
        maxContentCharacters: 24_000,
      }).map(({ candidate, score }) => ({ ...candidate, score }));

      if (formattedResults.length === 0) {
        return [
          'No content found in the files. The files may not have been processed correctly or you may need to refine your query.',
          undefined,
        ];
      }

      const sources = formattedResults.map((result) => ({
        type: 'file',
        fileId: result.file_id,
        content: result.content,
        fileName: result.filename,
        relevance: result.score,
        pages: result.page ? [result.page] : [],
        pageRelevance: result.page ? { [result.page]: result.score } : {},
        canonicalUrl: result.canonicalUrl,
        knowledgeBaseName: result.knowledgeBaseName,
        knowledgeSourceName: result.knowledgeSourceName,
        sourceType: result.sourceType,
      }));

      const citationConfig = appConfig?.endpoints?.[EModelEndpoint.agents];
      const citationSources = fileCitations
        ? selectFileCitationSources(sources, citationConfig)
        : [];
      const formattedString = formattedResults
        .map((result, index) => {
          const citationIndex = citationSources.indexOf(sources[index]);
          const provenance = [result.knowledgeBaseName, result.knowledgeSourceName]
            .filter(Boolean)
            .join(' / ');
          return `File: ${result.filename}${provenance ? `\nKnowledge source: ${provenance}` : ''}${
            citationIndex >= 0
              ? `\nAnchor: \\ue202turn0file${citationIndex} (${result.filename})`
              : ''
          }\nRelevance: ${result.score.toFixed(4)}\nContent: ${result.content}\n`;
        })
        .join('\n---\n');

      return [formattedString, { [Tools.file_search]: { sources, fileCitations } }];
    },
    {
      name: Tools.file_search,
      responseFormat: 'content_and_artifact',
      description: `Performs semantic search across attached "${Tools.file_search}" documents using natural language queries. This tool analyzes the content of uploaded files to find relevant information, quotes, and passages that best match your query. Use this to extract specific information or find relevant sections within the available documents.${
        fileCitations
          ? `

**CITE FILE SEARCH RESULTS:**
Use the EXACT anchor markers shown below (copy them verbatim) immediately after statements derived from file content. Reference the filename in your text:
- File citation: "The document.pdf states that... \\ue202turn0file0"  
- Page reference: "According to report.docx... \\ue202turn0file1"
- Multi-file: "Multiple sources confirm... \\ue200\\ue202turn0file0\\ue202turn0file1\\ue201"

**CRITICAL:** Output these escape sequences EXACTLY as shown (e.g., \\ue202turn0file0). Do NOT substitute with other characters like † or similar symbols.
**ALWAYS mention the filename in your text before the citation marker. NEVER use markdown links or footnotes.**`
          : ''
      }`,
      schema: fileSearchJsonSchema,
    },
  );
};

module.exports = { createFileSearchTool, primeFiles, fileSearchJsonSchema };
