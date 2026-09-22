import type {
  KnowledgeConnector,
  KnowledgeConnectorManifest,
  KnowledgeConnectorType,
} from './types';

export class KnowledgeConnectorRegistry {
  private readonly connectors = new Map<KnowledgeConnectorType, KnowledgeConnector>();

  register(connector: KnowledgeConnector): this {
    if (this.connectors.has(connector.manifest.type)) {
      throw new Error(`Knowledge connector already registered: ${connector.manifest.type}`);
    }
    this.connectors.set(connector.manifest.type, connector);
    return this;
  }

  get(type: KnowledgeConnectorType): KnowledgeConnector {
    const connector = this.connectors.get(type);
    if (!connector) {
      throw new Error(`Unknown knowledge connector: ${type}`);
    }
    return connector;
  }

  manifests(): KnowledgeConnectorManifest[] {
    return [...this.connectors.values()].map(({ manifest }) => manifest);
  }
}
