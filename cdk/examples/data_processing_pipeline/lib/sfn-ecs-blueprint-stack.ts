import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import { Construct } from 'constructs';
import { 
  addStepFunctionRolePolicies, 
  addEcsTaskExecutionRolePolicies, 
  addEcsTaskRolePolicies,
  addLambdaExecutionRolePolicies
} from './sfn-ecs-blueprint-roles';
import { 
  createDataProcessorStateMachine 
} from './sfn-ecs-blueprint-workflow';
import { TargetTrackingScalingPolicy } from 'aws-cdk-lib/aws-applicationautoscaling';


export class SfnEcsBlueprintStack extends cdk.Stack {
  
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Bucket for incoming files
    const bucket = new s3.Bucket(this, 'data-processing-incoming-bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Build the roles
    // * StepFunction execution role - Role assumed by Step Function
    // * Ecs Task Execution Role - Role assumed by ECS to execute tasks
    // * Ecs Task Role - Role assumed by task to perform its job
    // * Lambda execution role - Role to be assumed by Lambda to parse S3  
    const ecsTaskExecutionRole = new iam.Role (this, 'DataProcessorEcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role to run an ECS task'
    });
    const ecsTaskRole = new iam.Role (this, 'DataProcessorEcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role assumed by task to perform its function'
    });
    const stepFunctionExecutionRole = new iam.Role(this, 'DataProcessorStepFunctionExecutionRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      description: 'Stepfunction execution role'
    });
    stepFunctionExecutionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      effect: iam.Effect.ALLOW,
      resources: [ecsTaskExecutionRole.roleArn, ecsTaskRole.roleArn],
      conditions: {StringLike: {
        "iam:PassedToService": "ecs-tasks.amazonaws.com"
      }}
    }))
    const lambdaExecutionRole = new iam.Role(this, "DataProcessorLambdaExecutionRole", {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Lambda execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")
      ]
    })   
    addStepFunctionRolePolicies(cdk.Stack.of(this).account, cdk.Stack.of(this).region, stepFunctionExecutionRole);
    addEcsTaskExecutionRolePolicies(cdk.Stack.of(this).account, cdk.Stack.of(this).region, ecsTaskExecutionRole);
    addEcsTaskRolePolicies(cdk.Stack.of(this).account, cdk.Stack.of(this).region, ecsTaskRole);
    addLambdaExecutionRolePolicies(cdk.Stack.of(this).account, cdk.Stack.of(this).region, lambdaExecutionRole);

    // Create the ECS Cluster
    const vpc = new ec2.Vpc(this, 'DataProcessorVpc', { maxAzs: 2 });
    const ecsCluster = new ecs.Cluster(this, "DataProcessorCluster", {
      clusterName: "DataProcessorCluster",
      enableFargateCapacityProviders: true,
      vpc
    });

    // Specify the container to use
    const ecrRepository = ecr.Repository.fromRepositoryAttributes(this, 'ecrRepository', {
      repositoryName: 'process-data',
      repositoryArn: `arn:aws:ecr:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:repository/process-data`
    });

    // Create the fargate task definition
    const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'FargateTaskDefinition', {
      memoryLimitMiB: 512,
      cpu: 256,
      executionRole: ecsTaskExecutionRole,
      taskRole: ecsTaskRole
    });
    const container = fargateTaskDefinition.addContainer('data-processor', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, "latest"),
      memoryLimitMiB: 512,
      essential: true,
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ecs",
        mode: ecs.AwsLogDriverMode.NON_BLOCKING
      })
    });

    // Create the data preparation lambda function
    const dataPreparationFunction = new lambda.Function(this, "PrepareData", {
      runtime: lambda.Runtime.PYTHON_3_10,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'prepareData.lambda_handler',
      environment: {
        "input_bucket": bucket.bucketName
      },
      role: lambdaExecutionRole
    })

    // Create the state machine
    const dataProcessorWorkflow = createDataProcessorStateMachine(this, 
      ecsCluster, 
      fargateTaskDefinition, 
      container, 
      dataPreparationFunction,
      bucket.bucketName
    )
    
    // Create the EventBridge Scheduler to invoke the workflow at a given cron schedule
    const eventbridgeExecutionRole = new iam.Role(this, "DataProcessorEventBridgeSchedulerExecutionRole", {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role assumed by EventBridge scheduler to invoke workflow'
    })
    eventbridgeExecutionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions:['states:StartExecution'],
      effect: iam.Effect.ALLOW,
      resources:[dataProcessorWorkflow.stateMachineArn]
    }))

    const rule = new events.Rule(this, 'Rule', {
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '22' // 10 PM everyday
      })
    });
    rule.addTarget(new targets.SfnStateMachine(dataProcessorWorkflow, {
      role: eventbridgeExecutionRole
    })); 

  }

}