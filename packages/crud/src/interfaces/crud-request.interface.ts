import { ParsedRequestParams } from '@mfcdev/crud-request';

import { CrudRequestOptions } from '../interfaces';

export interface CrudRequest {
  parsed: ParsedRequestParams;
  options: CrudRequestOptions;
}
