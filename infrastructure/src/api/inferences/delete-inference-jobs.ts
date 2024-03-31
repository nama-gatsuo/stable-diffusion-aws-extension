import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { Aws, aws_lambda, Duration } from 'aws-cdk-lib';
import {
  JsonSchemaType,
  JsonSchemaVersion,
  LambdaIntegration,
  Model,
  RequestValidator,
  Resource,
} from 'aws-cdk-lib/aws-apigateway';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, LayerVersion, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface DeleteInferenceJobsApiProps {
  router: Resource;
  httpMethod: string;
  inferenceJobTable: Table;
  userTable: Table;
  srcRoot: string;
  commonLayer: LayerVersion;
  s3Bucket: Bucket;
}

export class DeleteInferenceJobsApi {
  public model: Model;
  public requestValidator: RequestValidator;
  private readonly src: string;
  private readonly router: Resource;
  private readonly httpMethod: string;
  private readonly scope: Construct;
  private readonly inferenceJobTable: Table;
  private readonly userTable: Table;
  private readonly layer: LayerVersion;
  private readonly baseId: string;
  private readonly s3Bucket: Bucket;

  constructor(scope: Construct, id: string, props: DeleteInferenceJobsApiProps) {
    this.scope = scope;
    this.baseId = id;
    this.router = props.router;
    this.httpMethod = props.httpMethod;
    this.inferenceJobTable = props.inferenceJobTable;
    this.userTable = props.userTable;
    this.src = props.srcRoot;
    this.layer = props.commonLayer;
    this.s3Bucket = props.s3Bucket;
    this.model = this.createModel();
    this.requestValidator = this.createRequestValidator();

    this.deleteInferenceJobsApi();
  }

  private createModel(): Model {
    return new Model(
      this.scope,
      `${this.baseId}-model`,
      {
        restApi: this.router.api,
        modelName: this.baseId,
        description: `${this.baseId} Request Model`,
        schema: {
          schema: JsonSchemaVersion.DRAFT4,
          title: this.baseId,
          type: JsonSchemaType.OBJECT,
          properties: {
            inference_id_list: {
              type: JsonSchemaType.ARRAY,
              items: {
                type: JsonSchemaType.STRING,
                minLength: 1,
              },
              minItems: 1,
              maxItems: 100,
            },
          },
          required: [
            'inference_id_list',
          ],
        },
        contentType: 'application/json',
      });
  }

  private createRequestValidator() {
    return new RequestValidator(
      this.scope,
      `${this.baseId}-del-infer-validator`,
      {
        restApi: this.router.api,
        validateRequestBody: true,
      });
  }

  private deleteInferenceJobsApi() {

    const lambdaFunction = new PythonFunction(
      this.scope,
      `${this.baseId}-lambda`,
      {
        entry: `${this.src}/inferences`,
        architecture: Architecture.X86_64,
        runtime: Runtime.PYTHON_3_10,
        index: 'delete_inference_jobs.py',
        handler: 'handler',
        timeout: Duration.seconds(900),
        role: this.iamRole(),
        memorySize: 2048,
        tracing: aws_lambda.Tracing.ACTIVE,
        environment: {
          INFERENCE_JOB_TABLE: this.inferenceJobTable.tableName,
        },
        layers: [this.layer],
      });


    const lambdaIntegration = new LambdaIntegration(
      lambdaFunction,
      {
        proxy: true,
      },
    );

    this.router.addMethod(
      this.httpMethod,
      lambdaIntegration,
      {
        apiKeyRequired: true,
        requestValidator: this.requestValidator,
        requestModels: {
          'application/json': this.model,
        },
      });

  }

  private iamRole(): Role {

    const newRole = new Role(
      this.scope,
      `${this.baseId}-role`,
      {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      },
    );

    newRole.addToPolicy(new PolicyStatement({
      actions: [
        // get an inference job
        'dynamodb:GetItem',
        // delete inference job
        'dynamodb:DeleteItem',
        // query users
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        this.inferenceJobTable.tableArn,
        this.userTable.tableArn,
      ],
    }));

    newRole.addToPolicy(new PolicyStatement({
      actions: [
        // delete inference file
        's3:DeleteObject',
      ],
      resources: [
        `${this.s3Bucket.bucketArn}/*`,
      ],
    }));

    newRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*:*`],
    }));

    return newRole;
  }
}
