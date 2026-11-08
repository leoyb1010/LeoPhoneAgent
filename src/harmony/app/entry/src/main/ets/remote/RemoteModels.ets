export class RemoteCapabilities {
  server: string = '';
  flags: string[] = [];
  has(name: string): boolean { return this.flags.includes(name); }
  static parse(raw: Object): RemoteCapabilities {
    const data = raw as Record<string, Object>;
    const result = new RemoteCapabilities();
    result.server = `${data['server'] ?? ''}`;
    const features = data['features'] as Record<string, Object> | undefined;
    if (features) {
      result.flags = Object.keys(features).filter((key: string) => features[key] === true);
    }
    return result;
  }
}

export class RemoteModel {
  provider: string = '';
  model: string = '';
  name: string = '';
  providerName: string = '';
  efforts: string[] = [];
  static parse(raw: Object): RemoteModel {
    const data = raw as Record<string, Object>;
    const result = new RemoteModel();
    result.provider = `${data['provider'] ?? ''}`;
    result.model = `${data['model'] ?? ''}`;
    result.name = `${data['name'] ?? result.model}`;
    result.providerName = `${data['provider_name'] ?? result.provider}`;
    const efforts = data['efforts'];
    if (Array.isArray(efforts)) { result.efforts = efforts.map((value: Object) => `${value}`); }
    return result;
  }
}

export class RemoteAttachment {
  name: string = '';
  mime: string = '';
  data_base64: string = '';
}

export class RemoteQuestion {
  question: string = '';
  labels: string[] = [];
  selected: string[] = [];
  text: string = '';
  multiple: boolean = false;
}

export class RemoteQuestionRequest {
  id: string = '';
  questions: RemoteQuestion[] = [];
  static parse(raw: Record<string, Object>): RemoteQuestionRequest {
    const result = new RemoteQuestionRequest();
    result.id = `${raw['question_id'] ?? ''}`;
    const questions = raw['questions'];
    if (!Array.isArray(questions)) { return result; }
    for (const item of questions as Object[]) {
      const data = item as Record<string, Object>;
      const question = new RemoteQuestion();
      question.question = `${data['question'] ?? ''}`;
      question.multiple = data['multi_select'] === true;
      const options = data['options'];
      if (Array.isArray(options)) {
        question.labels = options.map((option: Object) => `${(option as Record<string, Object>)['label'] ?? ''}`)
          .filter((value: string) => value.length > 0);
      }
      if (question.question) { result.questions.push(question); }
    }
    return result;
  }
}
